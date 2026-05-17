"""通过 stdin 传入密码，stdout 输出加密/解密结果。规避 shell 参数转义问题。"""
import sys

from crypto_utils import decrypt_password, encrypt_password

if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "encrypt"
    data = sys.stdin.read().strip()
    if not data:
        sys.exit(1)
    if mode == "decrypt":
        print(decrypt_password(data))
    else:
        print(encrypt_password(data))
