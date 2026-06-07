import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(__file__), "orchestrator.db")

def get_db_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Projects table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_name TEXT NOT NULL,
            local_path TEXT NOT NULL UNIQUE,
            repo_url TEXT,
            git_sync_status TEXT DEFAULT 'NOT_SYNCED',
            agent_type TEXT DEFAULT 'kilo',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    
    # Try to add new columns if table already exists
    try: cursor.execute("ALTER TABLE projects ADD COLUMN agent_type TEXT DEFAULT 'kilo'")
    except: pass
    try: cursor.execute("ALTER TABLE projects ADD COLUMN current_status TEXT DEFAULT 'IDLE'")
    except: pass
    try: cursor.execute("ALTER TABLE projects ADD COLUMN current_mode TEXT DEFAULT 'ASK'")
    except: pass
    try: cursor.execute("ALTER TABLE projects ADD COLUMN model_provider TEXT DEFAULT 'Gemini 1.5 Pro'")
    except: pass
    
    # Project Contexts table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS project_contexts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER,
            file_name TEXT NOT NULL,
            file_path TEXT NOT NULL,
            FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
    ''')
    
    # Chat History table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS chat_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER,
            role TEXT NOT NULL, -- 'user' or 'agent'
            message TEXT NOT NULL,
            mode TEXT, -- 'ASK', 'CODE', 'PLAN'
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
    ''')
    
    conn.commit()
    conn.close()

if __name__ == "__main__":
    init_db()
