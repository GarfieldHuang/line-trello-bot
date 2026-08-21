"""從 my-agent 的憑證存放處取出 refresh_token，複製到剪貼簿。

刻意不印出 token 本身，只印確認訊息與可公開的欄位資訊。
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

KEYCHAIN_SERVICE = "my-agent"
KEYCHAIN_KEY = "openai-token"
TOKEN_FILE = Path.home() / ".my-agent" / "token.json"


def load_token():
    try:
        import keyring
        raw = keyring.get_password(KEYCHAIN_SERVICE, KEYCHAIN_KEY)
        if raw:
            return json.loads(raw), "Windows 認證管理員"
    except Exception as e:
        print(f"[提示] 讀取認證管理員失敗：{e}")

    if TOKEN_FILE.exists():
        return json.loads(TOKEN_FILE.read_text(encoding="utf-8")), str(TOKEN_FILE)

    return None, None


def to_clipboard(text: str) -> bool:
    try:
        p = subprocess.run("clip", input=text.encode("utf-8"), shell=True)
        return p.returncode == 0
    except Exception as e:
        print(f"[提示] 複製到剪貼簿失敗：{e}")
        return False


def main():
    token, source = load_token()
    if not token:
        print("找不到已儲存的 token。請先在 PC 上跑一次 my-agent 登入。")
        return 1

    print(f"來源：{source}")
    print(f"包含欄位：{sorted(token.keys())}")

    exp = token.get("expires_at")
    if exp:
        stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(exp))
        state = "已過期（正常，GAS 會用 refresh 換新的）" if exp < time.time() else "仍有效"
        print(f"access_token 到期：{stamp}　{state}")

    rt = token.get("refresh_token")
    if not rt:
        print("\n這組 token 沒有 refresh_token。")
        print("→ 需要重新登入，且授權時 scope 必須包含 offline_access。")
        return 1

    ok = to_clipboard(rt)
    print(f"\nrefresh_token 長度：{len(rt)}")
    print("開頭四碼：" + rt[:4] + "…（僅供核對，不是完整值）")
    if ok:
        print("\n已複製到剪貼簿。直接到 Apps Script 的指令碼屬性貼上：")
        print("  屬性名稱：OPENAI_REFRESH_TOKEN")
    else:
        print("\n剪貼簿失敗。可以手動從認證管理員取出，或改用檔案輸出。")

    client_id = os.getenv("OPENAI_CLIENT_ID") or "app_EMoamEEZ73f0CkXaXp7hrann"
    print("\n另外要設的屬性：")
    print(f"  OPENAI_CLIENT_ID = {client_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
