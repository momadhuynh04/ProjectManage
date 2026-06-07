const API_URL = "http://127.0.0.1:8000/api";
const WS_URL = "ws://127.0.0.1:8000/ws";

let currentProjectId = null;
const activeSessions = {};
let projectsData = [];
let isRenaming = false;

// DOM Elements
const projectsTbody = document.getElementById('projects-tbody');

// Modals
const modalOverlay = document.getElementById('modal-overlay');
const modalTitle = document.getElementById('modal-title');
const inputProjectName = document.getElementById('input-project-name');
const inputProjectPath = document.getElementById('input-project-path');
const inputRepoUrl = document.getElementById('input-repo-url');
let isCloning = false;

// Command Center
const modalCmdOverlay = document.getElementById('modal-cmd-overlay');
const cmdProjectName = document.getElementById('cmd-project-name');
const cmdProjectPath = document.getElementById('cmd-project-path');
const terminalContainer = document.getElementById('terminal-container');
const btnStartAgent = document.getElementById('btn-start-agent');
const btnKillAgent = document.getElementById('btn-kill-agent');
const btnRestartAgent = document.getElementById('btn-restart-agent');
const agentSelect = document.getElementById('agent-select');
const providerSelect = document.getElementById('provider-select');
const modelSelect = document.getElementById('model-select');
const contextListEl = document.getElementById('context-list');
const agentStatusListEl = document.getElementById('agent-status-list');

// Session Management
// activeSessions = { [projectId]: { term, fitAddon, ws, interval, container, status } }

// Context Add Modal
const modalCtxOverlay = document.getElementById('modal-context-overlay');
const inputCtxName = document.getElementById('input-ctx-name');
const inputCtxContent = document.getElementById('input-ctx-content');

async function init() {
    await fetchAgentsStatus();
    await fetchProjects();
    setupEventListeners();
    
    // Poll real-time dashboard updates every 3s
    setInterval(() => {
        fetchProjects();
        fetchAgentsStatus();
    }, 3000);

    // Watch for modal resize to tell active terminals to fit themselves
    const resizeObserver = new ResizeObserver(() => {
        const cmdModal = document.querySelector('.cmd-modal');
        if (!cmdModal || cmdModal.clientWidth === 0) return; // Tránh lỗi thu nhỏ về 0 khi ẩn Modal

        Object.values(activeSessions).forEach(session => {
            if (session.container.style.display !== 'none' && session.fitAddon && session.ws && session.ws.readyState === WebSocket.OPEN) {
                try {
                    const oldCols = session.term.cols;
                    const oldRows = session.term.rows;
                    session.fitAddon.fit();
                    if (oldCols !== session.term.cols || oldRows !== session.term.rows) {
                        session.ws.send(JSON.stringify({ type: 'resize', cols: session.term.cols, rows: session.term.rows }));
                    }
                } catch(e) {}
            }
        });
    });
    const cmdModal = document.querySelector('.cmd-modal');
    if (cmdModal) resizeObserver.observe(cmdModal);
}

async function fetchAgentsStatus() {
    try {
        const res = await fetch(`${API_URL}/system/agents-status`);
        const statuses = await res.json();
        agentStatusListEl.innerHTML = '';
        for (const [agent, isInstalled] of Object.entries(statuses)) {
            // Render sidebar item
            const dotClass = isInstalled ? 'dot-green' : 'dot-red';
            agentStatusListEl.innerHTML += `
                <div class="agent-status-item">
                    <span>${agent.toUpperCase()}</span>
                    <span class="dot ${dotClass}"></span>
                </div>
            `;
            // Update dropdown disable state
            const opt = document.querySelector(`.agent-opt-${agent}`);
            if(opt) {
                if(!isInstalled) {
                    opt.disabled = true;
                    opt.innerText = opt.innerText.replace(' (Not Installed)', '') + ' (Not Installed)';
                } else {
                    opt.disabled = false;
                    opt.innerText = opt.innerText.replace(' (Not Installed)', '');
                }
            }
        }
    } catch (e) {
        console.error("Failed to fetch agent statuses", e);
    }
}

async function fetchProjects() {
    try {
        const res = await fetch(`${API_URL}/projects`);
        projectsData = await res.json();
        if (!isRenaming) renderProjects(projectsData);
    } catch (e) {
        console.error("Failed to fetch projects", e);
    }
}

function renderProjects(projects) {
    projectsTbody.innerHTML = '';
    projects.forEach(p => {
        const tr = document.createElement('tr');
        
        // Status class
        let statusHtml = `<span class="status-badge status-idle">CLOSED</span>`;
        if(p.current_status === 'READY') statusHtml = `<span class="status-badge status-running" style="background: rgba(59, 130, 246, 0.2); color: #3b82f6; border: 1px solid rgba(59, 130, 246, 0.5);">READY</span>`;
        else if(p.current_status === 'EXECUTE') statusHtml = `<span class="status-badge status-running" style="background: rgba(245, 158, 11, 0.2); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.5);"><span class="status-spinner"></span> EXECUTE</span>`;
        else if(p.current_status === 'DONE') statusHtml = `<span class="status-badge status-running" style="background: rgba(16, 185, 129, 0.2); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.5);">DONE</span>`;
        else if(p.current_status === 'ERROR') statusHtml = `<span class="status-badge status-error">ERROR</span>`;

        tr.innerHTML = `
            <td>
                <div style="display: flex; align-items: center; gap: 10px;">
                    <div style="flex: 1;">
                        <div class="project-name-editable" data-id="${p.id}" style="font-size: 1.05rem; font-weight: 600; margin-bottom: 4px; cursor: text; padding: 2px 4px; border-radius: 4px; transition: background 0.15s;" title="Double-click to rename">${p.project_name}</div>
                        <div style="font-size: 0.8rem; color: #94a3b8; font-family: monospace;">${p.local_path}</div>
                    </div>
                    <button class="btn-del-project" data-id="${p.id}" data-name="${p.project_name}" style="background: none; border: 1px solid rgba(239,68,68,0.3); color: #ef4444; padding: 3px 8px; border-radius: 4px; cursor: pointer; font-size: 0.75rem; flex-shrink: 0;" title="Remove project from list">✕</button>
                </div>
            </td>
            <td>
                <span style="font-size: 0.85rem; color: #94a3b8;">${p.repo_url ? `<a href="${p.repo_url}" target="_blank" style="color: #3b82f6;">${p.repo_url}</a>` : 'None'}</span>
                ${p.git_branch ? `<div style="font-size: 0.75rem; margin-top: 4px; color: #10b981;">${p.git_branch}${p.git_dirty ? ' (uncommitted)' : ''}</div>` : ''}
                ${p.git_sync_status !== 'NOT_SYNCED' ? `<div style="font-size: 0.7rem; margin-top: 2px; color: ${p.git_sync_status === 'DIRTY' ? '#f59e0b' : '#10b981'};">${p.git_sync_status}</div>` : ''}
            </td>
            <td>
                <div style="font-size: 0.9rem; margin-bottom: 4px;">${p.agent_type.toUpperCase()}</div>
                <div style="font-size: 0.8rem; color: #3b82f6;">${p.model_provider}</div>
            </td>
            <td>
                ${statusHtml}
            </td>
            <td>
                <div style="display: flex; gap: 8px;">
                    <button type="button" class="btn secondary sm btn-vscode" data-path="${p.local_path}" title="Open in VS Code" style="padding: 6px 10px; display: flex; align-items: center; justify-content: center;">
                        <svg width="18" height="18" viewBox="0 0 256 255" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid" style="pointer-events: none;">
                            <path d="M185.034 0L242.062 25.102L246.549 35.867V220.254L242.062 230.134L185.034 255.021L174.686 248.868L120.301 192.518L64.819 230.134L3.896 206.592L0 196.223L0 59.884L3.896 48.43L64.819 25.102L120.301 62.718L174.686 6.368L185.034 0ZM183.18 36.196L126.98 94.492L183.18 136.852V36.196ZM183.18 219.006V118.252L126.98 160.605L183.18 219.006ZM108.577 146.551L170.838 99.467L108.577 52.383L57.26 86.822L108.577 146.551ZM108.577 108.683L57.26 168.411L108.577 202.85L170.838 155.767L108.577 108.683ZM37.915 99.718L13.805 116.037V139.176L37.915 155.495L61.644 127.607L37.915 99.718Z" fill="#3b82f6"/>
                        </svg>
                    </button>
                    <button type="button" class="btn primary sm btn-cmd" data-id="${p.id}">🚀 Cmd Center</button>
                </div>
            </td>
        `;
        projectsTbody.appendChild(tr);
    });

    // Rebind action buttons
    document.querySelectorAll('.btn-vscode').forEach(btn => {
        btn.onclick = async (e) => {
            e.preventDefault();
            const path = e.target.getAttribute('data-path');
            await fetch(`${API_URL}/system/open-vscode?path=${encodeURIComponent(path)}`);
        };
    });

    document.querySelectorAll('.btn-cmd').forEach(btn => {
        btn.onclick = async (e) => {
            e.preventDefault();
            const id = parseInt(e.target.getAttribute('data-id'));
            const p = projects.find(x => x.id === id);
            if(p) openCommandCenter(p);
        };
    });

    document.querySelectorAll('.btn-del-project').forEach(btn => {
        btn.onclick = async (e) => {
            e.preventDefault();
            const id = parseInt(btn.dataset.id);
            const name = btn.dataset.name;
            if (confirm(`Remove "${name}" from the list?\n(Project files on disk will NOT be deleted)`)) {
                try {
                    const res = await fetch(`${API_URL}/projects/${id}`, { method: 'DELETE' });
                    if (!res.ok) throw new Error((await res.json()).detail);
                    fetchProjects();
                } catch (err) {
                    alert('Failed: ' + err.message);
                }
            }
        };
    });

    // Inline rename on double-click
    document.querySelectorAll('.project-name-editable').forEach(el => {
        el.ondblclick = function() {
            isRenaming = true;
            const id = parseInt(this.dataset.id);
            const currentName = this.textContent.trim();
            const input = document.createElement('input');
            input.type = 'text';
            input.value = currentName;
            input.style.cssText = 'font-size: 1.05rem; font-weight: 600; width: 100%; background: #1e293b; border: 1px solid #3b82f6; color: #f8fafc; padding: 2px 6px; border-radius: 4px; outline: none;';
            
            const parent = this.parentNode;
            this.replaceWith(input);
            input.focus();
            input.select();

            const save = async () => {
                const newName = input.value.trim();
                if (newName && newName !== currentName) {
                    try {
                        await fetch(`${API_URL}/projects/${id}`, {
                            method: 'PATCH',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({project_name: newName})
                        });
                    } catch(err) {
                        alert('Rename failed: ' + err.message);
                    }
                }
                isRenaming = false;
                fetchProjects();
            };

            input.onblur = save;
            input.onkeydown = (e) => {
                if (e.key === 'Enter') { input.blur(); }
                if (e.key === 'Escape') { input.value = currentName; input.blur(); }
            };
        };
    });

    document.querySelectorAll('.btn-cmd').forEach(btn => {
        btn.onclick = async (e) => {
            e.preventDefault();
            const id = parseInt(e.target.getAttribute('data-id'));
            const p = projects.find(x => x.id === id);
            if(p) openCommandCenter(p);
        };
    });
}

async function openCommandCenter(project) {
    currentProjectId = project.id;
    cmdProjectName.innerText = project.project_name;
    cmdProjectPath.innerText = project.local_path;
    agentSelect.value = project.agent_type || 'kilo';
    
    const inputModel = document.getElementById('model-display');
    if (inputModel) {
        inputModel.value = project.model_provider || 'Managed by Terminal';
    }
    
    modalCmdOverlay.classList.remove('hidden');

    // Hide all existing terminal containers
    Array.from(terminalContainer.children).forEach(child => child.style.display = 'none');

    let session = activeSessions[project.id];
    if (session) {
        // Terminal is already running for this project
        session.container.style.display = 'block';
        setTimeout(() => {
            try {
                const oldCols = session.term.cols;
                const oldRows = session.term.rows;
                session.fitAddon.fit();
                if (session.ws && session.ws.readyState === WebSocket.OPEN) {
                    if (oldCols !== session.term.cols || oldRows !== session.term.rows) {
                        session.ws.send(JSON.stringify({ type: 'resize', cols: session.term.cols, rows: session.term.rows }));
                    }
                }
                session.term.focus();
            } catch(e) {}
        }, 100); // Wait for browser to render the block display
        btnStartAgent.style.display = 'none';
        btnKillAgent.style.display = 'block';
        if (btnRestartAgent) btnRestartAgent.style.display = 'block';
    } else {
        // Create a new empty container for this project
        const container = document.createElement('div');
        container.id = `term-container-${project.id}`;
        container.style.width = '100%';
        container.style.height = '100%';
        container.style.display = 'block';
        terminalContainer.appendChild(container);
        
        btnStartAgent.style.display = 'block';
        btnKillAgent.style.display = 'none';
        if (btnRestartAgent) btnRestartAgent.style.display = 'none';
    }

    await fetchContexts(project.id);
    await fetchFileTree();
}

async function fetchFileTree() {
    if (!currentProjectId) return;
    try {
        const res = await fetch(`${API_URL}/projects/${currentProjectId}/tree`);
        const tree = await res.json();
        const treeEl = document.getElementById('file-tree');
        treeEl.innerHTML = renderTree(tree, 0);
    } catch(e) {
        console.error(e);
        document.getElementById('file-tree').innerHTML = 'Error loading tree';
    }
}

function renderTree(nodes, depth) {
    if (!nodes || nodes.length === 0) return '';
    let html = '';
    const padding = depth * 12;
    nodes.forEach(node => {
        if (node.type === 'directory') {
            const childrenHtml = renderTree(node.children, depth + 1);
            html += `
                <div class="tree-dir" style="margin-left: ${padding}px;">
                    <div style="display: flex; align-items: center; gap: 5px; cursor: pointer; padding: 3px 0; color: #e2e8f0; font-weight: bold; font-size: 0.85rem;" onclick="this.nextElementSibling.classList.toggle('hidden')">
                        <span>📁</span> ${node.name}
                    </div>
                    <div class="tree-children hidden">
                        ${childrenHtml}
                    </div>
                </div>
            `;
        } else {
            html += `
                <div class="tree-file" style="margin-left: ${padding + 18}px; display: flex; justify-content: space-between; align-items: center; padding: 3px 0; font-size: 0.8rem;">
                    <div style="display: flex; align-items: center; gap: 5px; cursor: default; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${node.path}">
                        <span>📄</span> ${node.name}
                    </div>
                    <button class="btn secondary sm" style="padding: 1px 4px; font-size: 0.65rem; border-color: #3b82f6; color: #3b82f6; opacity: 0.8; flex-shrink: 0; margin-left: 5px;" onclick="injectFile('${node.path.replace(/\\\\/g, '/').replace(/'/g, "\\'")}')">Inject</button>
                </div>
            `;
        }
    });
    return html;
}

window.injectFile = function(path) {
    const session = activeSessions[currentProjectId];
    if (session && session.ws && session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(JSON.stringify({ type: 'input', payload: `@${path} ` }));
    } else {
        alert("Agent is not running! Please start the agent first.");
    }
};

function startTerminal() {
    if (!currentProjectId) return;
    
    const projectId = currentProjectId;
    
    btnStartAgent.style.display = 'none';
    btnKillAgent.style.display = 'block';
    if (btnRestartAgent) btnRestartAgent.style.display = 'block';
    
    const activeContainer = document.getElementById(`term-container-${projectId}`);
    if (!activeContainer) return;
    activeContainer.innerHTML = '';
    
    const term = new Terminal({
        theme: {
            background: '#0f172a', // Đồng bộ với màu nền Modal
            foreground: '#e2e8f0',
            cursor: '#3b82f6',
            cursorAccent: '#0f172a',
            selectionBackground: 'rgba(59, 130, 246, 0.4)',
            black: '#1e293b',
            red: '#ef4444',
            green: '#10b981',
            yellow: '#f59e0b',
            blue: '#3b82f6',
            magenta: '#8b5cf6',
            cyan: '#06b6d4',
            white: '#f8fafc',
            brightBlack: '#64748b',
            brightRed: '#f87171',
            brightGreen: '#34d399',
            brightYellow: '#fbbf24',
            brightBlue: '#60a5fa',
            brightMagenta: '#a78bfa',
            brightCyan: '#22d3ee',
            brightWhite: '#ffffff'
        },
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace",
        fontSize: 14,
        lineHeight: 1.3,
        fontWeight: '500',
        cursorBlink: true,
        cursorStyle: 'bar',
        cursorWidth: 2,
        scrollback: 9999999,
        allowTransparency: true
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(activeContainer);
    fitAddon.fit();
    
    // Connect to WebSocket PTY with initial dimensions
    const ws = new WebSocket(`${WS_URL}/terminal/${projectId}?cols=${term.cols}&rows=${term.rows}`);
    
    // Store in activeSessions
    activeSessions[projectId] = {
        term: term,
        fitAddon: fitAddon,
        ws: ws,
        interval: null,
        status: 'CLOSED',
        container: activeContainer,
        savedModel: null
    };
    
    const session = activeSessions[projectId];
    
    let doneTimeout = null;
    const DONE_DELAY = 5000;

    ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        session.status = 'READY';
        updateProjectStatus(projectId, 'READY');
    };

    ws.onmessage = (event) => {
        if(event.data === '__STATS_UPDATE__') {
            fetchProjects();
        } else {
            term.write(event.data);
            if (session.status === 'EXECUTE') {
                if (doneTimeout) clearTimeout(doneTimeout);
                doneTimeout = setTimeout(() => {
                    session.status = 'DONE';
                    updateProjectStatus(projectId, 'DONE');
                    doneTimeout = null;
                }, DONE_DELAY);
            }
        }
    };

    ws.onclose = () => {
        term.write('\r\n\x1b[31m[Process disconnected]\x1b[0m\r\n');

        // Save terminal history
        let text = "";
        for (let i = 0; i < term.buffer.active.length; i++) {
            let line = term.buffer.active.getLine(i);
            if (line) text += line.translateToString(true) + "\n";
        }
        if (text.trim().length > 20) {
            const proj = projectsData.find(x => x.id === projectId);
            navigator.sendBeacon(`${API_URL}/projects/${projectId}/history`, JSON.stringify({
                content: text,
                agent_type: proj ? proj.agent_type : ''
            }));
        }

        if (doneTimeout) { clearTimeout(doneTimeout); doneTimeout = null; }

        if (currentProjectId === projectId) {
            btnStartAgent.style.display = 'block';
            btnKillAgent.style.display = 'none';
            if (btnRestartAgent) btnRestartAgent.style.display = 'none';
        }

        if (session.interval) {
            clearInterval(session.interval);
            session.interval = null;
        }
        session.status = 'CLOSED';
        fetchProjects();

        delete activeSessions[projectId];
    };

    term.onData((data) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'input', payload: data }));
            if (data.includes('\r')) {
                if (doneTimeout) clearTimeout(doneTimeout);
                session.status = 'EXECUTE';
                updateProjectStatus(projectId, 'EXECUTE');
                doneTimeout = setTimeout(() => {
                    session.status = 'DONE';
                    updateProjectStatus(projectId, 'DONE');
                    doneTimeout = null;
                }, DONE_DELAY);
            }
        }
    });

    // Extract Active Model from terminal buffer periodically
    session.interval = setInterval(() => {
        if (!term || !term.buffer || !term.buffer.active) return;
        let text = "";
        const baseY = term.buffer.active.baseY;
        for (let i = 0; i < term.rows; i++) {
            let line = term.buffer.active.getLine(baseY + i);
            if (line) text += line.translateToString(true) + "\n";
        }

        // --- Model Detection ---
        let foundModel = null;

        // 1. Try strict match for CLI formats like Kilo/OpenCode
        let kiloMatches = [...text.matchAll(/\b[A-Za-z]+\s+[-·•|]\s+(.+?)\s+(?:OpenRouter|Anthropic|Google|OpenAI|Groq|Together|DeepSeek|Ollama|LocalAI|Mistral|Cohere)\b/gi)];
        if (kiloMatches.length > 0) {
            foundModel = kiloMatches[kiloMatches.length - 1][1];
        }
        else {
            // 2. Try match for Blackbox/Codex format
            let bbMatches = [...text.matchAll(/([a-zA-Z0-9.-]+)\s+\((?:Blackbox|Codex)\)/gi)];
            if (bbMatches.length > 0) {
                foundModel = bbMatches[bbMatches.length - 1][1];
            } else {
                // 3. Try generic match for Gemini CLI or others
                let genericMatches = [...text.matchAll(/(gemini-[a-zA-Z0-9.-]+|claude-[a-zA-Z0-9.-]+|gpt-[a-zA-Z0-9.-]+|MiMo-[a-zA-Z0-9.-]+|deepseek-[a-zA-Z0-9.-]+|llama-[a-zA-Z0-9.-]+|qwen-[a-zA-Z0-9.-]+|nemotron-[a-zA-Z0-9.-]+)/gi)];
                if (genericMatches.length > 0) {
                    foundModel = genericMatches[genericMatches.length - 1][1];
                }
            }
        }

        if (foundModel) {
            if (session._lastModel === foundModel) {
                session._modelStability = (session._modelStability || 1) + 1;
            } else {
                session._lastModel = foundModel;
                session._modelStability = 1;
            }

            if (session._modelStability >= 2) {
                if (currentProjectId === projectId) {
                    const inputModel = document.getElementById('model-display');
                    if (inputModel && inputModel.value !== foundModel) {
                        inputModel.value = foundModel;
                    }
                }

                if (session.savedModel !== foundModel) {
                    session.savedModel = foundModel;
                    const proj = projectsData.find(x => x.id === projectId);
                    const aType = proj ? proj.agent_type : 'kilo';

                    const payload = {
                        agent_type: aType,
                        model_provider: foundModel
                    };
                    fetch(`${API_URL}/projects/${projectId}/agent`, {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify(payload)
                    }).then(() => fetchProjects());
                }
            }
        }
    }, 800);
}

function killAgent() {
    const session = activeSessions[currentProjectId];
    if (session && session.ws && session.ws.readyState === WebSocket.OPEN) {
        // Send Ctrl+C or kill signal
        session.ws.send(JSON.stringify({ type: 'kill' }));
        session.ws.close();
    }
}

async function updateAgentConfig() {
    if(!currentProjectId) return;
    const payload = {
        agent_type: agentSelect.value,
        model_provider: "Managed by Terminal"
    };
    await fetch(`${API_URL}/projects/${currentProjectId}/agent`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
    });
    fetchProjects();
}

function setupEventListeners() {
    btnStartAgent.onclick = (e) => { e.preventDefault(); startTerminal(); };
    btnKillAgent.onclick = (e) => { e.preventDefault(); killAgent(); };
    if (btnRestartAgent) {
        btnRestartAgent.onclick = (e) => {
            e.preventDefault();
            const session = activeSessions[currentProjectId];
            if (session && session.ws && session.ws.readyState === WebSocket.OPEN) {
                // Send Ctrl+C (Interrupt) to un-freeze the CLI without losing history
                session.ws.send(JSON.stringify({ type: 'input', payload: '\x03' }));
                
                // Force UI to redraw in case of display glitches
                try {
                    session.term.refresh(0, session.term.rows - 1);
                    session.fitAddon.fit();
                    session.ws.send(JSON.stringify({ type: 'resize', cols: session.term.cols, rows: session.term.rows }));
                    session.term.focus();
                } catch(err) {}
            }
        };
    }

    // Agent Config changes
    agentSelect.onchange = async (e) => { 
        e.preventDefault();
        updateAgentConfig(); 
    };

    // Handle window resize for all active terminals
    window.addEventListener('resize', () => {
        Object.values(activeSessions).forEach(session => {
            if (session.fitAddon && session.ws && session.ws.readyState === WebSocket.OPEN) {
                try {
                    session.fitAddon.fit();
                    session.ws.send(JSON.stringify({ type: 'resize', cols: session.term.cols, rows: session.term.rows }));
                } catch(e) {}
            }
        });
    });
    // Context file button delegation
    contextListEl.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-ctx-action]');
        if (!btn) return;
        const action = btn.dataset.ctxAction;
        const file = btn.dataset.ctxFile;
        if (action === 'edit') editContext(file);
        else if (action === 'inject') injectContext(file);
        else if (action === 'delete') deleteContext(file);
    });

    // Dashboard Buttons
    document.getElementById('btn-add-local').onclick = (e) => { e.preventDefault(); showModal(false); };
    document.getElementById('btn-clone-git').onclick = (e) => { e.preventDefault(); showModal(true); };
    document.getElementById('btn-modal-cancel').onclick = (e) => { e.preventDefault(); hideModal(); };
    document.getElementById('btn-close-cmd').onclick = (e) => { 
        e.preventDefault(); 
        modalCmdOverlay.classList.add('hidden'); 
        // Do not call ws.close() here, so the agent continues running in the background!
    };

    document.getElementById('btn-browse-folder').onclick = async (e) => {
        e.preventDefault();
        try {
            const res = await fetch(`${API_URL}/system/select-folder`);
            const data = await res.json();
            if (data.path) {
                inputProjectPath.value = data.path;
            }
        } catch (e) {
            console.error("Failed to select folder", e);
        }
    };
    
    document.getElementById('btn-modal-submit').onclick = async (e) => {
        e.preventDefault();
        const payload = {
            project_name: inputProjectName.value,
            local_path: inputProjectPath.value
        };
        
        let endpoint = `${API_URL}/projects`;
        if (isCloning) {
            payload.repo_url = inputRepoUrl.value;
            endpoint = `${API_URL}/projects/clone`;
        }

        try {
            document.getElementById('btn-modal-submit').innerText = "Processing...";
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || "Server error");
            await fetchProjects();
            hideModal();
        } catch (e) {
            alert("Error: " + e.message);
        } finally {
            document.getElementById('btn-modal-submit').innerText = "Confirm";
        }
    };
    
    // Context Files
    document.getElementById('btn-add-context').onclick = (e) => {
        e.preventDefault();
        if(!currentProjectId) return alert("Select a project first");
        inputCtxName.value = '';
        inputCtxContent.value = '';
        modalCtxOverlay.classList.remove('hidden');
    };
    
    document.getElementById('btn-modal-ctx-cancel').onclick = (e) => {
        e.preventDefault();
        modalCtxOverlay.classList.add('hidden');
    };
    
    document.getElementById('btn-modal-ctx-submit').onclick = async (e) => {
        e.preventDefault();
        const payload = {
            file_name: inputCtxName.value,
            content: inputCtxContent.value
        };
        try {
            document.getElementById('btn-modal-ctx-submit').innerText = "Saving...";
            const res = await fetch(`${API_URL}/projects/${currentProjectId}/contexts`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(payload)
            });
            if (!res.ok) throw new Error((await res.json()).detail);
            await fetchContexts(currentProjectId);
            modalCtxOverlay.classList.add('hidden');
        } catch (e) {
            alert("Error: " + e.message);
        } finally {
            document.getElementById('btn-modal-ctx-submit').innerText = "Save File";
        }
    };
}

async function updateProjectStatus(projectId, status) {
    if (!projectId) return;
    try {
        await fetch(`${API_URL}/projects/${projectId}/status`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({status: status})
        });
        fetchProjects();
    } catch(e) {
        console.error(e);
    }
}

async function fetchContexts(projectId) {
    try {
        const res = await fetch(`${API_URL}/projects/${projectId}/contexts`);
        const contexts = await res.json();
        contextListEl.innerHTML = '';
        contexts.forEach(ctx => {
            contextListEl.innerHTML += `
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 5px; background: rgba(0,0,0,0.2); padding: 6px 8px; border-radius: 4px;">
                    <span style="color: #e2e8f0; font-size: 0.85rem; word-break: break-all;">${ctx.file_name}</span>
                    <div style="display: flex; gap: 5px;">
                        <button data-ctx-action="edit" data-ctx-file="${ctx.file_name}" class="btn secondary sm" style="padding: 2px 6px; font-size: 0.75rem;">Edit</button>
                        <button data-ctx-action="inject" data-ctx-file="${ctx.file_name}" class="btn secondary sm" style="padding: 2px 6px; font-size: 0.75rem; color: #3b82f6; border-color: #3b82f6;">Inject</button>
                        <button data-ctx-action="delete" data-ctx-file="${ctx.file_name}" class="btn secondary sm" style="padding: 2px 6px; font-size: 0.75rem; color: #ef4444; border-color: #ef4444;">Del</button>
                    </div>
                </div>
            `;
        });
    } catch(e) {
        console.error(e);
    }
}

async function injectContext(fileName) {
    const session = activeSessions[currentProjectId];
    if (session && session.ws && session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(JSON.stringify({ type: 'input', payload: `@${fileName} ` }));
        try { session.term.focus(); } catch(e) {}
    } else {
        alert("Agent is not running! Please start the agent first.");
    }
}

async function deleteContext(fileName) {
    if (confirm(`Are you sure you want to completely delete ${fileName}?`)) {
        try {
            const res = await fetch(`${API_URL}/projects/${currentProjectId}/contexts/${encodeURIComponent(fileName)}`, {
                method: 'DELETE'
            });
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.detail || 'Delete failed');
            }
            await fetchContexts(currentProjectId);
        } catch (e) {
            alert("Error: " + e.message);
        }
    }
}

async function editContext(fileName) {
    try {
        const res = await fetch(`${API_URL}/projects/${currentProjectId}/contexts/${encodeURIComponent(fileName)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Unknown error');
        
        inputCtxName.value = fileName;
        inputCtxContent.value = data.content || '';
        modalCtxOverlay.classList.remove('hidden');
    } catch (e) {
        alert("Error: " + e.message);
    }
}

function showModal(clone) {
    isCloning = clone;
    modalTitle.innerText = clone ? "Clone Git Repository" : "Add Local Project";
    inputRepoUrl.classList.toggle('hidden', !clone);
    inputProjectName.value = '';
    inputProjectPath.value = '';
    inputRepoUrl.value = '';
    modalOverlay.classList.remove('hidden');
}

function hideModal() {
    modalOverlay.classList.add('hidden');
}

init();
