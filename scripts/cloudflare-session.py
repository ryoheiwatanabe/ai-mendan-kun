"""Cloudflare資格情報を表示・平文ファイル保存せずに利用する。

start: 非表示ダイアログから親Tokenを受け取り、無期限の作業Tokenを作成。
start --keychain: ユーザーが保存を許可した場合だけOSキーチェーンへ保存。
resume: キーチェーンから既存の作業Tokenを再利用する。
status / resources / wrangler: ローカルUNIX socket越しに操作。秘密値は返さない。
ソケットとメタデータに秘密値は含めない。環境ファイルは作成しない。
"""
from __future__ import annotations

import datetime as dt
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / ".local"
SOCKET = LOCAL / "cf.sock"
METADATA = LOCAL / "cloudflare-session.json"
API = "https://api.cloudflare.com/client/v4"
PERMISSIONS = ["Account Settings Read", "Workers Scripts Write", "D1 Write", "Vectorize Write"]
KEYCHAIN_SERVICE = "ai-mendan-kun.cloudflare-deploy"
ADMIN_PROCESS = None


class SafeError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise SafeError("APIの予期しない転送を拒否しました。")


def api(token, method, path, body=None):
    if not path.startswith("/") or "://" in path:
        raise SafeError("不正なAPIパスです。")
    request = urllib.request.Request(API + path, method=method,
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as error:
        # レスポンス本文・ヘッダに認証値が混ざっても出力しない。
        raise SafeError("Cloudflare API HTTP " + str(error.code)) from None
    except Exception:
        raise SafeError("Cloudflare APIに接続できませんでした。作成中の場合は再試行前にダッシュボードでToken一覧を確認してください。") from None
    if not payload.get("success"):
        raise SafeError("Cloudflare APIが操作を拒否しました。")
    return payload.get("result")


def dialog(message, hidden=False):
    # 入力値は子プロセスのpipeからPythonメモリへ受け取る。ログへ転送しない。
    script = 'text returned of (display dialog ' + json.dumps(message, ensure_ascii=False) + ' with title "AI面談くん：Cloudflare設定" default answer ""' + (' with hidden answer' if hidden else '') + ' buttons {"キャンセル", "入力"} default button "入力")'
    result = subprocess.run(["/usr/bin/osascript", "-e", script], capture_output=True, text=True)
    if result.returncode:
        raise SafeError("入力を中止しました。")
    value = result.stdout.strip()
    if not value:
        raise SafeError("入力が空です。")
    return value


def permission_policy(groups, account_id):
    selected = []
    for name in PERMISSIONS:
        aliases = {name, name.replace(" Write", " Edit")}
        matches = [group for group in groups if group.get("name") in aliases and "com.cloudflare.api.account" in group.get("scopes", [])]
        if len(matches) != 1:
            raise SafeError("必要な権限を一意に確認できませんでした: " + name)
        selected.append({"id": matches[0]["id"]})
    return {"effect": "allow", "resources": {"com.cloudflare.api.account." + account_id: "*"}, "permission_groups": selected}


def keychain_save(account_id, token):
    # securityの対話入力へ渡し、秘密値をプロセス引数にも出さない。
    import shlex
    command = "add-generic-password -U -a " + shlex.quote(account_id) + " -s " + shlex.quote(KEYCHAIN_SERVICE) + " -w " + shlex.quote(token) + "\n"
    result = subprocess.run(["/usr/bin/security", "-i"], input=command, capture_output=True, text=True)
    if result.returncode:
        raise SafeError("キーチェーンへの保存が完了しませんでした。")
    # 対話モード全体の終了コードだけに依存せず、同じ資格情報が保存されたことを確認する。
    if keychain_read(account_id) != token:
        raise SafeError("キーチェーンへの保存を確認できませんでした。")


def keychain_read(account_id):
    result = subprocess.run(["/usr/bin/security", "find-generic-password", "-a", account_id, "-s", KEYCHAIN_SERVICE, "-w"], capture_output=True, text=True)
    if result.returncode: raise SafeError("保存済みの作業Tokenを読み込めませんでした。")
    return result.stdout.strip()


def start(persist=False, resume=False):
    LOCAL.mkdir(mode=0o700, exist_ok=True)
    os.chmod(LOCAL, 0o700)
    if SOCKET.exists():
        try:
            with socket.socket(socket.AF_UNIX) as check:
                check.connect(str(SOCKET))
            raise SafeError("既存の資格情報セッションがあります。statusで確認してください。")
        except (ConnectionRefusedError, FileNotFoundError):
            SOCKET.unlink(missing_ok=True)
    if resume:
        info = json.loads(METADATA.read_text())
        if info.get("storage") != "macos-keychain": raise SafeError("キーチェーンへ保存されたセッションではありません。")
        token = keychain_read(info["accountId"])
        api(token, "GET", "/accounts/" + info["accountId"])
        info["pid"] = os.getpid()
        return serve(token, info)
    account_id = dialog("AI面談くんで使用するCloudflare Account ID（32文字）を入力してください。ダッシュボードURLの dash.cloudflare.com/ の直後にあるIDです。")
    if not re.fullmatch(r"[a-f0-9]{32}", account_id):
        raise SafeError("Account IDは32文字の英小文字・数字で指定してください。")
    parent = dialog("トークン作成権限を持つ親API Tokenを貼り付けてください。親Tokenは表示・保存しません。対象アカウントのWorkers/D1/Vectorize編集とAccount Settings閲覧だけを持つ無期限Tokenを作成します。", hidden=True)
    if re.search(r"\s", parent) or len(parent) < 20:
        raise SafeError("Tokenの形式を確認してください。")
    token_path = "/accounts/" + account_id + "/tokens" if parent.startswith("cfat_") else "/user/tokens"
    groups = api(parent, "GET", token_path + "/permission_groups")
    policy = permission_policy(groups, account_id)
    name = "ai-mendan-kun-dev-" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    result = api(parent, "POST", token_path, {"name": name, "policies": [policy]})
    token, token_id = result.get("value"), result.get("id")
    if not token or not token_id:
        raise SafeError("Token作成結果を確認できません。ダッシュボードのToken一覧を確認してください。")
    try:
        account = api(token, "GET", "/accounts/" + account_id)
        if persist: keychain_save(account_id, token)
    except SafeError:
        api(parent, "DELETE", token_path + "/" + token_id)
        raise SafeError("対象アカウントまたは保存結果を確認できなかったため、作成したTokenを取り消しました。") from None
    # 親Tokenを保持する必要はない。以降の操作は限定Tokenだけを使用する。
    del parent, result
    info = {"tokenId": token_id, "name": name, "accountId": account_id, "accountName": account.get("name"),
        "permissions": PERMISSIONS, "expiresOn": None, "pid": os.getpid(), "storage": "macos-keychain" if persist else "process-memory-only"}
    serve(token, info)


def serve(token, info):
    account_id = info["accountId"]
    METADATA.write_text(json.dumps(info, ensure_ascii=False, indent=2))
    os.chmod(METADATA, 0o600)
    with socket.socket(socket.AF_UNIX) as server:
        server.bind(str(SOCKET)); os.chmod(SOCKET, 0o600); server.listen(4)
        print(json.dumps({"status": "ready", **info}, ensure_ascii=False), flush=True)
        try:
            while True:
                server.settimeout(60)
                try:
                    connection, _ = server.accept()
                except socket.timeout:
                    continue
                with connection:
                    connection.settimeout(5)
                    data = b""
                    while b"\n" not in data and len(data) < 20_000:
                        part = connection.recv(4096)
                        if not part: break
                        data += part
                    if not data: continue
                    try:
                        request = json.loads(data)
                        output = dispatch(request, token, account_id, info)
                    except SafeError as error:
                        output = {"error": str(error)}
                    except Exception:
                        output = {"error": "操作が完了しませんでした。秘密値を保護するため詳細出力を省略しました。"}
                    encoded = json.dumps(output, ensure_ascii=False).replace(token, "[REDACTED]").encode()
                    connection.sendall(encoded)
        finally:
            stop_admin()
            SOCKET.unlink(missing_ok=True)


def dispatch(request, token, account_id, info):
    global ADMIN_PROCESS
    action = request.get("action")
    if action == "status": return {"status": "ready", **info}
    environment = {**os.environ, "CLOUDFLARE_API_TOKEN": token, "CLOUDFLARE_ACCOUNT_ID": account_id,
        "CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV": "false", "WRANGLER_SEND_METRICS": "false", "WRANGLER_LOG": "log", "WRANGLER_WRITE_LOGS": "false"}
    if action == "deployment-status":
        result = {}
        for name, suffix in [("subdomain", "/workers/subdomain"), ("route", "/workers/scripts/ai-mendan-kun/subdomain")]:
            try: result[name] = api(token, "GET", "/accounts/" + account_id + suffix)
            except SafeError as error: result[name] = {"status": str(error)}
        return result
    if action == "admin-start":
        if not (ROOT / "node_modules/wrangler/bin/wrangler.js").exists(): raise SafeError("Wranglerのインストールはまだ完了していません。")
        if ADMIN_PROCESS is not None and ADMIN_PROCESS.poll() is None: return {"status": "running", "pid": ADMIN_PROCESS.pid}
        ADMIN_PROCESS = subprocess.Popen(["node", "scripts/admin-dev.mjs"], cwd=ROOT, env=environment, stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        return {"status": "starting", "pid": ADMIN_PROCESS.pid, "url": "http://127.0.0.1:8790"}
    if action == "admin-status":
        return {"status": "running" if ADMIN_PROCESS is not None and ADMIN_PROCESS.poll() is None else "stopped"}
    if action == "admin-stop":
        stop_admin(); return {"status": "stopped"}
    if action in {"put-openai-secret", "put-gemini-secret"}:
        provider, secret_name = ("Gemini", "GEMINI_API_KEY") if action == "put-gemini-secret" else ("OpenAI", "OPENAI_API_KEY")
        value = dialog("AI面談くん用の" + provider + " APIキーを入力してください。値は表示・保存せず、Cloudflare Workersの" + secret_name + "へ登録します。", hidden=True)
        api(token, "PUT", "/accounts/" + account_id + "/workers/scripts/ai-mendan-kun/secrets", {"name": secret_name, "text": value, "type": "secret_text"})
        return {"status": "saved", "secretName": secret_name}
    if action == "resources":
        result = {}
        for name, suffix in [("workers", "/workers/scripts"), ("d1", "/d1/database"), ("vectorize", "/vectorize/v2/indexes")]:
            rows = api(token, "GET", "/accounts/" + account_id + suffix)
            if not isinstance(rows, list): raise SafeError("リソース一覧の形式が想定と異なります。")
            result[name] = [{key: row[key] for key in ("id", "uuid", "name") if key in row} for row in rows]
        return result
    if action == "wrangler":
        args = request.get("args", [])
        if not args or args[0] not in {"whoami", "d1", "vectorize", "deploy", "versions", "secret"} or not all(isinstance(arg, str) for arg in args):
            raise SafeError("このセッションで許可されていないコマンドです。")
        cli = ROOT / "node_modules/wrangler/bin/wrangler.js"
        if not cli.exists(): raise SafeError("Wranglerのインストールはまだ完了していません。")
        process = subprocess.run(["node", str(cli), *args], cwd=ROOT, env=environment, capture_output=True, text=True, timeout=180)
        return {"exitCode": process.returncode, "output": (process.stdout + process.stderr)[-24_000:]}
    raise SafeError("操作名が不正です。")


def stop_admin():
    global ADMIN_PROCESS
    if ADMIN_PROCESS is not None and ADMIN_PROCESS.poll() is None:
        os.killpg(ADMIN_PROCESS.pid, signal.SIGTERM)
        try: ADMIN_PROCESS.wait(timeout=5)
        except subprocess.TimeoutExpired: os.killpg(ADMIN_PROCESS.pid, signal.SIGKILL)
    ADMIN_PROCESS = None


def client(action, args):
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(200)
        connection.connect(str(SOCKET))
        connection.sendall(json.dumps({"action": action, "args": args}).encode() + b"\n")
        connection.shutdown(socket.SHUT_WR)
        result = b""
        while True:
            part = connection.recv(65536)
            if not part: break
            result += part
    print(result.decode())


if __name__ == "__main__":
    try:
        action = sys.argv[1] if len(sys.argv) > 1 else "status"
        if action == "start": start(persist="--keychain" in sys.argv[2:])
        elif action == "resume": start(resume=True)
        else: client(action, sys.argv[2:])
    except SafeError as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), flush=True)
        sys.exit(1)
    except KeyboardInterrupt:
        pass
    except Exception:
        print('{"error":"資格情報セッションに接続できません。秘密値を保護するため詳細出力を省略しました。"}', flush=True)
        sys.exit(1)
