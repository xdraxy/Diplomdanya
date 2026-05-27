"""
SyncPlay — модуль аутентификации (email + пароль, JWT в httpOnly cookies).
Поддерживается также Bearer-токен в Authorization header.
"""
import os
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

import bcrypt
import jwt
from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, EmailStr, Field, field_validator

JWT_ALGORITHM = "HS256"
ACCESS_TOKEN_MIN = 60 * 24       # 1 день (для удобства SPA — обновляется при перезаходе)
REFRESH_TOKEN_DAYS = 30          # 30 дней

NAME_REGEX = re.compile(r"^[a-zA-Zа-яА-ЯёЁ0-9 .\-_]{2,50}$")

# ---------------------------------------------------------------------------
# Хелперы
# ---------------------------------------------------------------------------
def hash_password(password: str) -> str:
    salt = bcrypt.gensalt()
    return bcrypt.hashpw(password.encode("utf-8"), salt).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        return False


def _jwt_secret() -> str:
    return os.environ["JWT_SECRET"]


def create_access_token(user_id: str, email: str) -> str:
    payload = {
        "sub": user_id,
        "email": email,
        "exp": datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_MIN),
        "type": "access",
    }
    return jwt.encode(payload, _jwt_secret(), algorithm=JWT_ALGORITHM)


def create_refresh_token(user_id: str) -> str:
    payload = {
        "sub": user_id,
        "exp": datetime.now(timezone.utc) + timedelta(days=REFRESH_TOKEN_DAYS),
        "type": "refresh",
    }
    return jwt.encode(payload, _jwt_secret(), algorithm=JWT_ALGORITHM)


def set_auth_cookies(response: Response, access_token: str, refresh_token: str) -> None:
    response.set_cookie(
        key="access_token",
        value=access_token,
        httponly=True,
        secure=False,
        samesite="lax",
        max_age=ACCESS_TOKEN_MIN * 60,
        path="/",
    )
    response.set_cookie(
        key="refresh_token",
        value=refresh_token,
        httponly=True,
        secure=False,
        samesite="lax",
        max_age=REFRESH_TOKEN_DAYS * 24 * 3600,
        path="/",
    )


def clear_auth_cookies(response: Response) -> None:
    response.delete_cookie("access_token", path="/")
    response.delete_cookie("refresh_token", path="/")


def _extract_token(request: Request) -> Optional[str]:
    token = request.cookies.get("access_token")
    if not token:
        auth = request.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            token = auth[7:]
    return token


def _public_user(doc: dict) -> dict:
    return {
        "id": str(doc["_id"]),
        "email": doc["email"],
        "display_name": doc.get("display_name") or doc.get("email", "").split("@")[0],
        "role": doc.get("role", "user"),
        "created_at": doc.get("created_at"),
    }


# ---------------------------------------------------------------------------
# Зависимости FastAPI
# ---------------------------------------------------------------------------
def make_auth_dependencies(get_db):
    """Возвращает (get_current_user_required, get_current_user_optional)."""

    async def required(request: Request) -> dict:
        db = get_db()
        token = _extract_token(request)
        if not token:
            raise HTTPException(status_code=401, detail="Требуется авторизация")
        try:
            payload = jwt.decode(token, _jwt_secret(), algorithms=[JWT_ALGORITHM])
            if payload.get("type") != "access":
                raise HTTPException(status_code=401, detail="Неверный тип токена")
            user = await db.users.find_one({"_id": ObjectId(payload["sub"])})
            if not user:
                raise HTTPException(status_code=401, detail="Пользователь не найден")
            return _public_user(user)
        except jwt.ExpiredSignatureError:
            raise HTTPException(status_code=401, detail="Срок действия токена истёк")
        except jwt.InvalidTokenError:
            raise HTTPException(status_code=401, detail="Неверный токен")

    async def optional(request: Request) -> Optional[dict]:
        try:
            return await required(request)
        except HTTPException:
            return None

    return required, optional


# ---------------------------------------------------------------------------
# Pydantic схемы
# ---------------------------------------------------------------------------
class RegisterPayload(BaseModel):
    email: EmailStr
    password: str = Field(min_length=6, max_length=128)
    display_name: str = Field(min_length=2, max_length=50)

    @field_validator("display_name")
    @classmethod
    def name_valid(cls, v: str) -> str:
        v = v.strip()
        if not NAME_REGEX.match(v):
            raise ValueError("Имя содержит недопустимые символы")
        return v


class LoginPayload(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


# ---------------------------------------------------------------------------
# Brute force защита
# ---------------------------------------------------------------------------
MAX_FAILED_ATTEMPTS = 5
LOCKOUT_MINUTES = 15


async def _check_lockout(db, identifier: str) -> None:
    rec = await db.login_attempts.find_one({"identifier": identifier})
    if not rec:
        return
    if rec.get("count", 0) >= MAX_FAILED_ATTEMPTS:
        locked_until = rec.get("locked_until")
        if locked_until and locked_until > datetime.now(timezone.utc):
            raise HTTPException(
                status_code=429,
                detail="Слишком много неудачных попыток. Попробуйте через 15 минут.",
            )
        # окно прошло — сбрасываем
        await db.login_attempts.delete_one({"identifier": identifier})


async def _register_failure(db, identifier: str) -> None:
    now = datetime.now(timezone.utc)
    rec = await db.login_attempts.find_one({"identifier": identifier})
    count = (rec["count"] if rec else 0) + 1
    update = {"$set": {"count": count, "updated_at": now}}
    if count >= MAX_FAILED_ATTEMPTS:
        update["$set"]["locked_until"] = now + timedelta(minutes=LOCKOUT_MINUTES)
    await db.login_attempts.update_one(
        {"identifier": identifier}, update, upsert=True
    )


async def _clear_failures(db, identifier: str) -> None:
    await db.login_attempts.delete_one({"identifier": identifier})


# ---------------------------------------------------------------------------
# Router builder
# ---------------------------------------------------------------------------
def build_auth_router(get_db, get_current_user_required):
    router = APIRouter(prefix="/api/auth", tags=["auth"])

    @router.post("/register")
    async def register(payload: RegisterPayload, response: Response):
        db = get_db()
        email = payload.email.lower()
        existing = await db.users.find_one({"email": email})
        if existing:
            raise HTTPException(status_code=409, detail="Пользователь с такой почтой уже зарегистрирован")
        doc = {
            "email": email,
            "password_hash": hash_password(payload.password),
            "display_name": payload.display_name,
            "role": "user",
            "created_at": datetime.now(timezone.utc),
        }
        res = await db.users.insert_one(doc)
        user_id = str(res.inserted_id)
        set_auth_cookies(
            response,
            create_access_token(user_id, email),
            create_refresh_token(user_id),
        )
        doc["_id"] = res.inserted_id
        return _public_user(doc)

    @router.post("/login")
    async def login(payload: LoginPayload, request: Request, response: Response):
        db = get_db()
        email = payload.email.lower()
        ip = request.client.host if request.client else "unknown"
        identifier = f"{ip}:{email}"

        await _check_lockout(db, identifier)

        user = await db.users.find_one({"email": email})
        if not user or not verify_password(payload.password, user["password_hash"]):
            await _register_failure(db, identifier)
            raise HTTPException(status_code=401, detail="Неверная почта или пароль")

        await _clear_failures(db, identifier)
        user_id = str(user["_id"])
        set_auth_cookies(
            response,
            create_access_token(user_id, email),
            create_refresh_token(user_id),
        )
        return _public_user(user)

    @router.post("/logout")
    async def logout(response: Response):
        clear_auth_cookies(response)
        return {"ok": True}

    @router.get("/me")
    async def me(user: dict = Depends(get_current_user_required)):
        return user

    @router.post("/refresh")
    async def refresh(request: Request, response: Response):
        db = get_db()
        token = request.cookies.get("refresh_token")
        if not token:
            raise HTTPException(status_code=401, detail="Нет refresh-токена")
        try:
            payload = jwt.decode(token, _jwt_secret(), algorithms=[JWT_ALGORITHM])
            if payload.get("type") != "refresh":
                raise HTTPException(status_code=401, detail="Неверный тип токена")
            user = await db.users.find_one({"_id": ObjectId(payload["sub"])})
            if not user:
                raise HTTPException(status_code=401, detail="Пользователь не найден")
        except jwt.ExpiredSignatureError:
            raise HTTPException(status_code=401, detail="Refresh-токен истёк")
        except jwt.InvalidTokenError:
            raise HTTPException(status_code=401, detail="Неверный refresh-токен")

        user_id = str(user["_id"])
        access = create_access_token(user_id, user["email"])
        response.set_cookie(
            key="access_token",
            value=access,
            httponly=True,
            secure=False,
            samesite="lax",
            max_age=ACCESS_TOKEN_MIN * 60,
            path="/",
        )
        return _public_user(user)

    return router


# ---------------------------------------------------------------------------
# Admin seed + indexes
# ---------------------------------------------------------------------------
async def setup_auth(db: AsyncIOMotorDatabase) -> None:
    # Индексы
    await db.users.create_index("email", unique=True)
    await db.login_attempts.create_index("identifier")
    await db.login_attempts.create_index("updated_at", expireAfterSeconds=60 * 60 * 24)

    # Admin seed
    admin_email = os.environ.get("ADMIN_EMAIL", "admin@syncplay.local").lower()
    admin_password = os.environ.get("ADMIN_PASSWORD", "admin123")
    existing = await db.users.find_one({"email": admin_email})
    if existing is None:
        await db.users.insert_one(
            {
                "email": admin_email,
                "password_hash": hash_password(admin_password),
                "display_name": "Администратор",
                "role": "admin",
                "created_at": datetime.now(timezone.utc),
            }
        )
    elif not verify_password(admin_password, existing["password_hash"]):
        await db.users.update_one(
            {"email": admin_email},
            {"$set": {"password_hash": hash_password(admin_password)}},
        )
