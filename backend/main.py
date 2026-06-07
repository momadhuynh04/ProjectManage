from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import sqlite3
import subprocess
import asyncio
import os
import shutil
import json
import re
import threading
import socket
from winpty import PTY
from database import get_db_connection, init_db

NODEJS_AGENTS = {"gemini", "claude", "codex"}

app = FastAPI(title="Omni-Orchestrator Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("startup")
def startup_event():
    init_db()
    conn = get_db_connection()
    conn.execute("UPDATE projects SET current_status = 'CLOSED'")
    conn.commit()
    conn.close()

class ProjectCreate(BaseModel):
    project_name: str
    local_path: str
    
class ProjectClone(BaseModel):
    project_name: str
    repo_url: str
    local_path: str

class ProjectAgentUpdate(BaseModel):
    agent_type: str
    model_provider: str

class ProjectRename(BaseModel):
    project_name: str

class HistorySave(BaseModel):
    content: str
    agent_type: str = ""

@app.post("/api/projects/{project_id}/history")
def save_history(project_id: int, payload: HistorySave):
    from datetime import datetime
    conn = get_db_connection()
    project = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    conn.close()
    if not project: raise HTTPException(status_code=404)
    history_dir = os.path.join(project['local_path'], "history")
    os.makedirs(history_dir, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"session_{ts}_{payload.agent_type}.md"
    file_path = os.path.join(history_dir, filename)
    header = f"# Session: {project['project_name']}\n# Agent: {payload.agent_type}\n# Date: {datetime.now().isoformat()}\n\n"
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(header + payload.content)
    return {"status": "saved", "file": filename}

class ContextCreate(BaseModel):
    file_name: str
    content: str

@app.get("/api/system/open-vscode")
def open_vscode(path: str):
    try:
        subprocess.Popen(["code", path], shell=True)
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/system/agents-status")
def get_agents_status():
    agents = ["claude", "kilo", "gemini", "codex", "opencode", "blackbox"]
    status = {}
    for agent in agents:
        status[agent] = shutil.which(agent) is not None
    return status

_models_cache = {}
_models_cache_ts = {}

@app.get("/api/system/agent-models/{agent_name}")
def get_agent_models(agent_name: str):
    import time
    
    now = time.time()
    if agent_name in _models_cache and (now - _models_cache_ts.get(agent_name, 0)) < 60:
        return _models_cache[agent_name]
    
    result = {}
    
    def parse_provider_model_output(output):
        parsed = {}
        for line in output.strip().split("\n"):
            line = line.strip()
            if not line or "/" not in line:
                continue
            parts = line.split("/", 1)
            provider = parts[0]
            model = parts[1]
            if provider not in parsed:
                parsed[provider] = []
            parsed[provider].append(model)
        return parsed
    
    try:
        if agent_name in ("kilo", "opencode"):
            proc = subprocess.run([agent_name, "models"], capture_output=True, text=True, timeout=30, shell=True)
            if proc.returncode == 0 and proc.stdout.strip():
                result = parse_provider_model_output(proc.stdout)
                
        elif agent_name == "gemini":
            result = {
                "google": [
                    "gemini-3.1-pro-preview", "gemini-3-flash-preview", "gemini-3.1-flash-lite-preview",
                    "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite",
                    "gemma-4-31b-it", "gemma-4-26b-a4b-it"
                ]
            }
            
        elif agent_name == "claude":
            result = {
                "anthropic": [
                    "sonnet", "opus", "haiku", "claude-sonnet-4-6", "claude-opus-4-6",
                    "claude-sonnet-4-20250514", "claude-haiku-3.5", "claude-sonnet-3.5-v2"
                ]
            }
            
        elif agent_name == "codex":
            result = {
                "openai": ["codex-mini", "o4-mini", "o3", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano"]
            }
            
        elif agent_name == "blackbox":
            result = {"blackbox": ["blackbox-ai"]}
            
    except Exception as e:
        result = {"error": [str(e)]}
    
    _models_cache[agent_name] = result
    _models_cache_ts[agent_name] = now
    return result

@app.get("/api/system/select-folder")
def select_folder():
    code = """
import tkinter as tk
from tkinter import filedialog
root = tk.Tk()
root.withdraw()
root.attributes('-topmost', True)
folder = filedialog.askdirectory(parent=root, title='Select Directory')
root.destroy()
print(folder)
"""
    result = subprocess.run(["python", "-c", code], capture_output=True, text=True)
    folder = result.stdout.strip()
    return {"path": folder}

def _detect_git_info(local_path):
    git_dir = os.path.join(local_path, ".git")
    if not os.path.exists(git_dir):
        return None, None, None
    try:
        remote = subprocess.run(["git", "remote", "get-url", "origin"], cwd=local_path, capture_output=True, text=True, timeout=3)
        branch = subprocess.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=local_path, capture_output=True, text=True, timeout=3)
        status = subprocess.run(["git", "status", "--porcelain"], cwd=local_path, capture_output=True, text=True, timeout=3)
        repo_url = remote.stdout.strip() if remote.returncode == 0 else None
        branch_name = branch.stdout.strip() if branch.returncode == 0 else None
        is_dirty = len(status.stdout.strip()) > 0 if status.returncode == 0 else None
        return repo_url, branch_name, is_dirty
    except Exception:
        return None, None, None

@app.get("/api/projects")
def get_projects():
    conn = get_db_connection()
    projects = conn.execute("SELECT * FROM projects").fetchall()
    result = []
    for p in projects:
        pd = dict(p)
        if not pd.get("repo_url"):
            detected_url, branch, dirty = _detect_git_info(pd["local_path"])
            if detected_url:
                sync_status = "DIRTY" if dirty else "SYNCED"
                conn.execute("UPDATE projects SET repo_url = ?, git_sync_status = ? WHERE id = ?", (detected_url, sync_status, pd["id"]))
                conn.commit()
                pd["repo_url"] = detected_url
                pd["git_branch"] = branch
                pd["git_dirty"] = dirty
                pd["git_sync_status"] = sync_status
        result.append(pd)
    conn.close()
    return result

@app.post("/api/projects")
def create_project(project: ProjectCreate):
    conn = get_db_connection()
    try:
        os.makedirs(project.local_path, exist_ok=True)
        name = project.project_name.strip() if project.project_name and project.project_name.strip() else os.path.basename(project.local_path.rstrip('\\/'))
        cursor = conn.execute(
            "INSERT INTO projects (project_name, local_path) VALUES (?, ?)",
            (name, project.local_path)
        )
        conn.commit()
        project_id = cursor.lastrowid
        return {"id": project_id, "project_name": name, "local_path": project.local_path}
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=400, detail="Path already exists as a project.")
    finally:
        conn.close()

@app.delete("/api/projects/{project_id}")
def delete_project(project_id: int):
    conn = get_db_connection()
    conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
    conn.commit()
    if conn.total_changes == 0:
        conn.close()
        raise HTTPException(status_code=404, detail="Project not found")
    conn.close()
    return {"status": "deleted"}

@app.patch("/api/projects/{project_id}")
def rename_project(project_id: int, payload: ProjectRename):
    conn = get_db_connection()
    conn.execute("UPDATE projects SET project_name = ? WHERE id = ?", (payload.project_name, project_id))
    conn.commit()
    if conn.total_changes == 0:
        conn.close()
        raise HTTPException(status_code=404, detail="Project not found")
    conn.close()
    return {"status": "renamed", "project_name": payload.project_name}

@app.post("/api/projects/clone")
def clone_project(project: ProjectClone):
    conn = get_db_connection()
    try:
        if os.path.exists(project.local_path) and os.listdir(project.local_path):
             raise HTTPException(status_code=400, detail="Target path is not empty.")
             
        os.makedirs(project.local_path, exist_ok=True)
        process = subprocess.run(
            ["git", "clone", project.repo_url, "."],
            cwd=project.local_path,
            capture_output=True, text=True
        )
        if process.returncode != 0:
            raise HTTPException(status_code=500, detail=f"Git clone failed: {process.stderr}")

        cursor = conn.execute(
            "INSERT INTO projects (project_name, local_path, repo_url, git_sync_status) VALUES (?, ?, ?, 'SYNCED')",
            (project.project_name, project.local_path, project.repo_url)
        )
        conn.commit()
        project_id = cursor.lastrowid
        return {"id": project_id, "project_name": project.project_name, "local_path": project.local_path}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        conn.close()

@app.post("/api/projects/{project_id}/agent")
def update_agent(project_id: int, payload: ProjectAgentUpdate):
    conn = get_db_connection()
    conn.execute("UPDATE projects SET agent_type = ?, model_provider = ? WHERE id = ?", (payload.agent_type, payload.model_provider, project_id))
    conn.commit()
    conn.close()
    return {"status": "success", "agent_type": payload.agent_type, "model_provider": payload.model_provider}

@app.get("/api/projects/{project_id}/contexts")
def get_contexts(project_id: int):
    conn = get_db_connection()
    project = conn.execute("SELECT local_path FROM projects WHERE id = ?", (project_id,)).fetchone()
    conn.close()
    if not project or not os.path.exists(project['local_path']):
        return []
        
    local_path = project['local_path']
    files = []
    for f in os.listdir(local_path):
        if f.endswith('.md'):
            files.append({"file_name": f})
    return files

@app.get("/api/projects/{project_id}/contexts/{file_name}")
def get_context_content(project_id: int, file_name: str):
    conn = get_db_connection()
    project = conn.execute("SELECT local_path FROM projects WHERE id = ?", (project_id,)).fetchone()
    conn.close()
    if not project: raise HTTPException(status_code=404)
    file_path = os.path.join(project['local_path'], file_name)
    if not os.path.exists(file_path): raise HTTPException(status_code=404)
    with open(file_path, "r", encoding="utf-8") as f:
        return {"content": f.read()}

@app.post("/api/projects/{project_id}/contexts")
def create_context(project_id: int, payload: ContextCreate):
    conn = get_db_connection()
    project = conn.execute("SELECT local_path FROM projects WHERE id = ?", (project_id,)).fetchone()
    conn.close()
    if not project: raise HTTPException(status_code=404)
    
    file_name = payload.file_name
    if not file_name.endswith('.md'):
        file_name += '.md'
    file_path = os.path.join(project['local_path'], file_name)
    
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(payload.content)
        
    return {"file_name": file_name}

@app.delete("/api/projects/{project_id}/contexts/{file_name}")
def delete_context(project_id: int, file_name: str):
    conn = get_db_connection()
    project = conn.execute("SELECT local_path FROM projects WHERE id = ?", (project_id,)).fetchone()
    conn.close()
    if not project: raise HTTPException(status_code=404)
    file_path = os.path.join(project['local_path'], file_name)
    if os.path.exists(file_path):
        os.remove(file_path)
    return {"status": "deleted"}

def build_tree(dir_path, root_path):
    tree = []
    try:
        for entry in sorted(os.scandir(dir_path), key=lambda e: (not e.is_dir(), e.name.lower())):
            if entry.name.startswith('.') or entry.name in ['node_modules', '__pycache__', 'venv', 'env', 'dist', 'build']:
                continue
            rel_path = os.path.relpath(entry.path, root_path).replace('\\', '/')
            if entry.is_dir():
                tree.append({
                    "name": entry.name,
                    "type": "directory",
                    "path": rel_path,
                    "children": build_tree(entry.path, root_path)
                })
            else:
                tree.append({
                    "name": entry.name,
                    "type": "file",
                    "path": rel_path
                })
    except PermissionError:
        pass
    return tree

@app.get("/api/projects/{project_id}/tree")
def get_project_tree(project_id: int):
    conn = get_db_connection()
    project = conn.execute("SELECT local_path FROM projects WHERE id = ?", (project_id,)).fetchone()
    conn.close()
    if not project or not os.path.exists(project['local_path']):
        return []
    return build_tree(project['local_path'], project['local_path'])

@app.get("/api/projects/{project_id}/chat")
def get_chat_history(project_id: int):
    conn = get_db_connection()
    chats = conn.execute("SELECT * FROM chat_history WHERE project_id = ? ORDER BY id ASC", (project_id,)).fetchall()
    conn.close()
    return [dict(c) for c in chats]

# Connection Manager for WebSockets
class TerminalManager:
    def __init__(self):
        self.terminals = {}

    async def connect(self, websocket: WebSocket, project_id: int):
        await websocket.accept()

    def disconnect(self, project_id: int):
        if project_id in self.terminals:
            entry = self.terminals[project_id]
            if "pty" in entry:
                try:
                    pid = entry["pty"].pid
                    if pid:
                        subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)], capture_output=True)
                except:
                    pass
            elif "bridge" in entry:
                try:
                    bridge = entry["bridge"]
                    if bridge.process:
                        subprocess.run(["taskkill", "/F", "/T", "/PID", str(bridge.process.pid)], capture_output=True)
                except:
                    pass
            del self.terminals[project_id]

terminal_manager = TerminalManager()

import traceback

ALT_SCREEN_RE = re.compile(r'\x1b\[\?1049[hl]')
CURSOR_SAVE_RE = re.compile(r'\x1b\[s|\x1b7')
CURSOR_RESTORE_RE = re.compile(r'\x1b\[u|\x1b8')

def sanitize_ansi(data: str) -> str:
    data = ALT_SCREEN_RE.sub('', data)
    data = CURSOR_SAVE_RE.sub('', data)
    data = CURSOR_RESTORE_RE.sub('', data)
    return data

def pty_reader(pty_obj, websocket: WebSocket, loop, project_id: int, is_nodejs: bool = False):
    try:
        while True:
            try:
                data = pty_obj.read(blocking=True)
                if not data:
                    break
                if is_nodejs:
                    data = sanitize_ansi(data)
                asyncio.run_coroutine_threadsafe(websocket.send_text(data), loop)
            except Exception as e:
                with open("debug.log", "a") as f:
                    f.write(f"Read loop err: {str(e)}\n")
                    traceback.print_exc(file=f)
                break
    except Exception as e:
        with open("debug.log", "a") as f:
            f.write(f"Outer err: {str(e)}\n")
            traceback.print_exc(file=f)
    finally:
        try:
            asyncio.run_coroutine_threadsafe(websocket.close(), loop)
        except:
            pass


def _find_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('', 0))
        return s.getsockname()[1]


class NodePTYBridge:
    def __init__(self):
        self.process = None
        self.bridge_ws = None
        self.port = None

    async def start(self, command: str, cwd: str, cols: int, rows: int):
        self.port = _find_free_port()
        bridge_script = os.path.join(os.path.dirname(__file__), "pty_bridge.js")
        self.process = subprocess.Popen(
            ["node", bridge_script, str(self.port), command, cwd, str(cols), str(rows)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )
        await asyncio.sleep(0.8)
        if self.process.poll() is not None:
            _, stderr = self.process.communicate()
            raise RuntimeError(f"node-pty bridge exited early: {stderr.decode()}")

    async def connect(self):
        import websockets
        uri = f"ws://127.0.0.1:{self.port}"
        for _ in range(20):
            try:
                self.bridge_ws = await websockets.connect(uri)
                ready_msg = await self.bridge_ws.recv()
                ready = json.loads(ready_msg)
                if ready.get("type") == "ready":
                    return
            except Exception:
                await asyncio.sleep(0.2)
        raise RuntimeError("Failed to connect to node-pty bridge")

    async def forward_output(self, frontend_ws: WebSocket):
        try:
            async for msg in self.bridge_ws:
                parsed = json.loads(msg)
                if parsed.get("type") == "output":
                    await frontend_ws.send_text(parsed["data"])
                elif parsed.get("type") == "exit":
                    break
        except Exception:
            pass

    async def send_input(self, data: str):
        if self.bridge_ws:
            await self.bridge_ws.send(json.dumps({"type": "input", "data": data}))

    async def send_resize(self, cols: int, rows: int):
        if self.bridge_ws:
            await self.bridge_ws.send(json.dumps({"type": "resize", "cols": cols, "rows": rows}))

    async def kill(self):
        if self.bridge_ws:
            try:
                await self.bridge_ws.send(json.dumps({"type": "kill"}))
            except:
                pass
        if self.process:
            try:
                self.process.terminate()
                self.process.wait(timeout=3)
            except:
                try:
                    self.process.kill()
                except:
                    pass

    async def close(self):
        if self.bridge_ws:
            try:
                await self.bridge_ws.close()
            except:
                pass
        await self.kill()

@app.websocket("/ws/terminal/{project_id}")
async def websocket_terminal(websocket: WebSocket, project_id: int, cols: int = 80, rows: int = 24):
    await terminal_manager.connect(websocket, project_id)
    loop = asyncio.get_running_loop()

    conn = get_db_connection()
    project = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    conn.execute("UPDATE projects SET current_status = 'READY' WHERE id = ?", (project_id,))
    conn.commit()
    conn.close()

    agent = project['agent_type'] if project and project['agent_type'] else "kilo"
    model = project['model_provider'] if project and project['model_provider'] else ""
    cwd = project['local_path'] if project else "."

    cmd = "cmd.exe"
    if agent == "kilo":
        cmd = "kilo.cmd"
        if model and " / " in model:
            model_flag = model.replace(" / ", "/")
            cmd += f" --model {model_flag}"
    elif agent == "gemini":
        cmd = "gemini.cmd"
        if model and " / " in model:
            cmd += f" -m {model.split(' / ')[1]}"
    elif agent == "opencode":
        cmd = "opencode.cmd"
        if model and " / " in model:
            cmd += f" -m {model.replace(' / ', '/')}"
    elif agent == "claude":
        cmd = "claude.cmd"
    elif agent == "codex":
        cmd = "codex.cmd"
        if model and " / " in model:
            cmd += f" -m {model.split(' / ')[1]}"
    elif agent == "blackbox":
        cmd = "blackbox.cmd"
        if model and " / " in model:
            cmd += f" -m {model.split(' / ')[1]}"

    is_nodejs = agent in NODEJS_AGENTS

    if is_nodejs:
        await _handle_nodejs_agent(websocket, project_id, cmd, cwd, cols, rows, agent, loop)
    else:
        await _handle_native_agent(websocket, project_id, cmd, cwd, cols, rows, agent, loop)


async def _handle_nodejs_agent(websocket, project_id, cmd, cwd, cols, rows, agent, loop):
    bridge = NodePTYBridge()
    try:
        full_cmd = f"cmd.exe /c echo [Backend] Terminal connected... && {cmd}"
        await bridge.start(full_cmd, cwd, cols, rows)
        await bridge.connect()

        terminal_manager.terminals[project_id] = {"bridge": bridge}

        await websocket.send_text("\r\n\x1b[36m[Backend] Node-PTY bridge connected.\x1b[0m\r\n")

        forward_task = asyncio.create_task(bridge.forward_output(websocket))

        try:
            while True:
                data = await websocket.receive_json()
                msg_type = data.get("type")

                if msg_type == "input":
                    await bridge.send_input(data.get("payload", ""))
                elif msg_type == "resize":
                    await bridge.send_resize(data.get("cols", 80), data.get("rows", 24))
                elif msg_type == "kill":
                    await bridge.kill()
                    try:
                        await websocket.close()
                    except:
                        pass
                    break
        except WebSocketDisconnect:
            pass

        forward_task.cancel()
        try:
            await forward_task
        except asyncio.CancelledError:
            pass

    except Exception as e:
        with open("debug.log", "a") as f:
            f.write(f"NodeJS bridge err: {str(e)}\n")
            traceback.print_exc(file=f)
        try:
            await websocket.send_text(f"\r\n\x1b[31mError: {str(e)}\x1b[0m\r\n")
        except:
            pass
    finally:
        await bridge.close()
        terminal_manager.disconnect(project_id)
        conn = get_db_connection()
        conn.execute("UPDATE projects SET current_status = 'CLOSED' WHERE id = ?", (project_id,))
        conn.commit()
        conn.close()


async def _handle_native_agent(websocket, project_id, cmd, cwd, cols, rows, agent, loop):
    full_cmd = f"cmd.exe /c echo [Backend] Terminal connected... && {cmd}"

    try:
        pty_process = PTY(cols, rows, backend=0)
        pty_process.spawn(r"C:\Windows\System32\cmd.exe", cmdline=full_cmd, cwd=cwd)
        terminal_manager.terminals[project_id] = {"pty": pty_process}

        async def delayed_resize():
            await asyncio.sleep(0.3)
            try:
                pty_process.set_size(cols, rows)
            except:
                pass
        asyncio.create_task(delayed_resize())

        t = threading.Thread(target=pty_reader, args=(pty_process, websocket, loop, project_id, False))
        t.daemon = True
        t.start()

        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")

            if msg_type == "input":
                payload = data.get("payload", "")
                pty_process.write(payload)
            elif msg_type == "resize":
                new_cols = data.get("cols", 80)
                new_rows = data.get("rows", 24)
                pty_process.set_size(new_cols, new_rows)
            elif msg_type == "kill":
                pty_process.write('\x03')
                try:
                    await websocket.close()
                except:
                    pass
                break

    except WebSocketDisconnect:
        pass
    except Exception as e:
        with open("debug.log", "a") as f:
            f.write(f"Websocket err: {str(e)}\n")
            traceback.print_exc(file=f)
        try:
            await websocket.send_text(f"\r\n\x1b[31mError: {str(e)}\x1b[0m\r\n")
        except:
            pass
    finally:
        terminal_manager.disconnect(project_id)
        conn = get_db_connection()
        conn.execute("UPDATE projects SET current_status = 'CLOSED' WHERE id = ?", (project_id,))
        conn.commit()
        conn.close()


class StatusUpdate(BaseModel):
    status: str

@app.put("/api/projects/{project_id}/status")
def update_project_status(project_id: int, payload: StatusUpdate):
    conn = get_db_connection()
    conn.execute("UPDATE projects SET current_status = ? WHERE id = ?", (payload.status, project_id))
    conn.commit()
    conn.close()
    return {"status": payload.status}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
