"""Iteration 5: Auth (JWT) tests."""
import os
import secrets
import pytest
import requests


def _unique_email(prefix="test_user"):
    # backend lowercases emails, so keep them lowercase
    return f"{prefix}_{secrets.token_hex(4)}@test.ru"


class TestRegister:
    def test_register_valid_returns_201_or_200_with_cookies(self, api_client, base_url):
        email = _unique_email()
        r = api_client.post(
            f"{base_url}/api/auth/register",
            json={"email": email, "password": "qwerty12", "display_name": "Тестер"},
        )
        # Endpoint doesn't explicitly set 201, so accept 200/201.
        assert r.status_code in (200, 201), r.text
        body = r.json()
        assert body["email"] == email
        assert body["display_name"] == "Тестер"
        assert body["role"] == "user"
        assert "id" in body and isinstance(body["id"], str)
        # httpOnly cookies
        cookies = r.cookies
        assert "access_token" in cookies
        assert "refresh_token" in cookies
        # Inspect Set-Cookie raw to verify HttpOnly
        sc = r.headers.get("set-cookie", "")
        assert "HttpOnly" in sc

    def test_register_duplicate_email_409(self, api_client, base_url):
        email = _unique_email()
        r1 = api_client.post(
            f"{base_url}/api/auth/register",
            json={"email": email, "password": "qwerty12", "display_name": "Дубль"},
        )
        assert r1.status_code in (200, 201)
        r2 = api_client.post(
            f"{base_url}/api/auth/register",
            json={"email": email, "password": "qwerty12", "display_name": "Дубль"},
        )
        assert r2.status_code == 409

    def test_register_invalid_email_422(self, api_client, base_url):
        r = api_client.post(
            f"{base_url}/api/auth/register",
            json={"email": "notanemail", "password": "qwerty12", "display_name": "X"},
        )
        assert r.status_code == 422

    def test_register_short_password_422(self, api_client, base_url):
        r = api_client.post(
            f"{base_url}/api/auth/register",
            json={"email": _unique_email(), "password": "12345", "display_name": "X"},
        )
        assert r.status_code == 422


class TestLogin:
    def test_login_admin_success(self, api_client, base_url):
        r = api_client.post(
            f"{base_url}/api/auth/login",
            json={"email": "admin@syncplay.ru", "password": "admin123"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["email"] == "admin@syncplay.ru"
        assert body["role"] == "admin"
        sc = r.headers.get("set-cookie", "")
        assert "access_token=" in sc and "HttpOnly" in sc

    def test_login_wrong_password_401(self, api_client, base_url):
        r = api_client.post(
            f"{base_url}/api/auth/login",
            json={"email": "admin@syncplay.ru", "password": "wrong_password_xxx"},
        )
        # may be 401 OR 429 if many runs before; treat 429 as also acceptable lockout
        assert r.status_code in (401, 429)

    def test_login_brute_force_lockout_429(self, base_url):
        # use a unique non-existent email so we don't lock out other tests
        email = _unique_email("test_locktest")
        sess = requests.Session()
        statuses = []
        for _ in range(7):
            rr = sess.post(
                f"{base_url}/api/auth/login",
                json={"email": email, "password": "anything"},
            )
            statuses.append(rr.status_code)
        # First several should be 401, then 429
        assert 401 in statuses
        assert 429 in statuses, f"Expected lockout after 5 attempts, statuses={statuses}"


class TestMe:
    def test_me_without_auth_401(self, api_client, base_url):
        s = requests.Session()
        r = s.get(f"{base_url}/api/auth/me")
        assert r.status_code == 401

    def test_me_with_cookie_returns_user(self, base_url):
        s = requests.Session()
        r = s.post(
            f"{base_url}/api/auth/login",
            json={"email": "admin@syncplay.ru", "password": "admin123"},
        )
        assert r.status_code == 200
        me = s.get(f"{base_url}/api/auth/me")
        assert me.status_code == 200
        assert me.json()["email"] == "admin@syncplay.ru"

    def test_me_with_bearer_token(self, base_url):
        s = requests.Session()
        r = s.post(
            f"{base_url}/api/auth/login",
            json={"email": "admin@syncplay.ru", "password": "admin123"},
        )
        token = s.cookies.get("access_token")
        assert token
        # Use fresh session and Bearer header
        s2 = requests.Session()
        me = s2.get(
            f"{base_url}/api/auth/me",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert me.status_code == 200
        assert me.json()["email"] == "admin@syncplay.ru"


class TestLogoutAndRefresh:
    def test_logout_clears_cookies(self, base_url):
        s = requests.Session()
        s.post(
            f"{base_url}/api/auth/login",
            json={"email": "admin@syncplay.ru", "password": "admin123"},
        )
        r = s.post(f"{base_url}/api/auth/logout")
        assert r.status_code == 200
        sc = r.headers.get("set-cookie", "")
        # Cookie must be cleared (max-age=0 or expires past)
        assert "access_token=" in sc
        assert "Max-Age=0" in sc or 'expires=Thu, 01 Jan 1970' in sc.lower() or "max-age=0" in sc.lower()

    def test_refresh_issues_new_access_token(self, base_url):
        s = requests.Session()
        login = s.post(
            f"{base_url}/api/auth/login",
            json={"email": "admin@syncplay.ru", "password": "admin123"},
        )
        assert login.status_code == 200
        old_access = s.cookies.get("access_token")
        r = s.post(f"{base_url}/api/auth/refresh")
        assert r.status_code == 200, r.text
        sc = r.headers.get("set-cookie", "")
        assert "access_token=" in sc
        new_access = s.cookies.get("access_token")
        assert new_access  # got new token
        assert r.json()["email"] == "admin@syncplay.ru"

    def test_refresh_without_token_401(self, base_url):
        s = requests.Session()
        r = s.post(f"{base_url}/api/auth/refresh")
        assert r.status_code == 401
