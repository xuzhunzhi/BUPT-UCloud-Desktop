"""Fetch user profile info from JWT token."""
import json
from pathlib import Path
from . import paths

def fetch_user_info(data_dir=None):
    """Read user info from auth_tokens.json JWT."""
    if data_dir is None:
        data_dir = Path(__file__).resolve().parent.parent
    try:
        auth = json.loads(Path(data_dir, "auth_tokens.json").read_text(encoding="utf-8"))
        token = auth.get("iclass_token", "")
        if not token:
            return None
        import base64
        parts = token.split(".")
        if len(parts) < 2:
            return None
        payload = parts[1] + "=" * (4 - len(parts[1]) % 4)
        info = json.loads(base64.urlsafe_b64decode(payload))
        return {
            "real_name": info.get("real_name", ""),
            "avatar": info.get("avatar", ""),
            "student_id": info.get("user_name", ""),
            "user_id": info.get("user_id", ""),
        }
    except Exception:
        return None
