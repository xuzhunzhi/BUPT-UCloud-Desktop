"""密码加密/解密工具（Fernet 对称加密，密钥存储在本地数据目录）。"""
from __future__ import annotations

from pathlib import Path

from cryptography.fernet import Fernet

from paths import DATA_DIR

_KEY_PATH = DATA_DIR / ".encryption_key"


def _get_or_create_key() -> bytes:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if _KEY_PATH.is_file():
        return _KEY_PATH.read_bytes()
    key = Fernet.generate_key()
    _KEY_PATH.write_bytes(key)
    return key


def encrypt_password(password: str) -> str:
    f = Fernet(_get_or_create_key())
    return f.encrypt(password.encode("utf-8")).decode("utf-8")


def decrypt_password(token: str) -> str:
    f = Fernet(_get_or_create_key())
    return f.decrypt(token.encode("utf-8")).decode("utf-8")


def is_encrypted(value: str) -> bool:
    """检测字符串是否为 Fernet token（以 gAAAAAB 开头）。"""
    return value.startswith("gAAAAAB")
