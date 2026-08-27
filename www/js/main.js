// git-lex viz — main entry point
// Modes: Recent Activity, Repo Graph, History
// W3BL0RD's domain. Pod with W4R3Z on the Rust side.

const API = '';

// ════════════════════════════════════════════
// SPARQL helpers
// ════════════════════════════════════════════

async function sparql(query) {
    try {
        const r = await fetch(API + '/api/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query })
        });
        const data = await r.json();
        if (data.error) {
            console.warn('SPARQL error:', data.error, '\nquery:', query);
            return [];
        }
        return data.results || [];
    } catch (e) {
        console.error('SPARQL fetch failed:', e);
        return [];
    }
}

// Strip namespace prefix to get a short label from a URI.
function shortName(uri) {
    if (!uri) return '';
    const hash = uri.lastIndexOf('#');
    if (hash >= 0) return uri.substring(hash + 1);
    const slash = uri.lastIndexOf('/');
    if (slash >= 0) return uri.substring(slash + 1);
    return uri;
}

// Strip extension from a filename
function stripExt(name) {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.substring(0, dot) : name;
}

// ════════════════════════════════════════════
// Mode routing
// ════════════════════════════════════════════

const modes = ['activity', 'graph', 'soul', 'history'];
const views = {};
modes.forEach(m => views[m] = document.getElementById('view-' + m));
const sidebarRight = document.getElementById('sidebar-right');

let currentMode = null;
const loaded = new Set();

function setMode(mode) {
    if (!modes.includes(mode)) mode = 'activity';
    currentMode = mode;

    document.querySelectorAll('.mode-link').forEach(a => {
        a.classList.toggle('active', a.dataset.mode === mode);
    });

    modes.forEach(m => {
        views[m].hidden = (m !== mode);
    });

    // Right sidebar on graph and history modes
    sidebarRight.hidden = (mode !== 'graph' && mode !== 'history');

    if (!loaded.has(mode)) {
        loaded.add(mode);
        if (mode === 'activity') loadActivity();
        if (mode === 'graph') loadGraph();
        if (mode === 'soul') initSoulView();
        if (mode === 'history') initHistory();
    }

    if (mode === 'graph') resizeGraph();
    if (mode === 'soul') resizeSoulCanvas();
    if (mode === 'history') resizeHistoryCanvas();
}

function initRouting() {
    document.querySelectorAll('.mode-link').forEach(a => {
        a.addEventListener('click', e => {
            e.preventDefault();
            const mode = a.dataset.mode;
            location.hash = mode;
            setMode(mode);
        });
    });

    window.addEventListener('hashchange', () => {
        const mode = location.hash.replace('#', '') || 'activity';
        setMode(mode);
    });

    const initial = location.hash.replace('#', '') || 'activity';
    setMode(initial);
}


// ════════════════════════════════════════════
// RECENT ACTIVITY (landing page)
// ════════════════════════════════════════════

async function loadActivity() {
    const view = views.activity;

    const [repoInfo, recentCommits, timeline] = await Promise.all([
        loadRepoInfo(),
        loadRecentCommits(30),
        loadCommitTimeline(),
    ]);

    let html = '';

    // Repo header
    html += '<div class="repo-header">';
    html += `<h1>${repoInfo.name || 'Repository'}</h1>`;
    html += '<div class="repo-subtitle">';
    if (repoInfo.kit) html += `<span>kit: ${repoInfo.kit}</span>`;
    if (repoInfo.created) html += `<span>since ${repoInfo.created}</span>`;
    if (repoInfo.commits) html += `<span>${repoInfo.commits} commits</span>`;
    if (repoInfo.docs) html += `<span>${repoInfo.docs} documents</span>`;
    if (repoInfo.totalTriples) html += `<span>${repoInfo.totalTriples.toLocaleString()} triples</span>`;
    html += '</div>';
    html += '</div>';

    // History scrubber timeline (Day 7 sketch — slider stub).
    // Wires to W4R3Z's planned /api/scrub?commit={sha} endpoint when it ships.
    if (timeline.length > 1) {
        html += renderTimeline(timeline);
    }

    // Recent activity
    if (recentCommits.length > 0) {
        html += '<div class="section">';
        html += '<div class="section-title">Recent activity</div>';
        html += '<div class="activity-list">';
        recentCommits.forEach(c => {
            const filesJson = escapeHtml(JSON.stringify(c.files || []));
            html += `<div class="activity-row" data-commit="${escapeHtml(c.id)}" data-files="${filesJson}">`;
            html += `<div class="when">${c.when}</div>`;
            html += `<div class="what">${escapeHtml(c.message)}</div>`;
            html += `<div class="changed">${c.changedHint || ''}</div>`;
            html += `<div class="who">${escapeHtml(c.author || '')}</div>`;
            html += '</div>';
        });
        html += '</div>';
        html += '</div>';
    }

    view.innerHTML = html;
    attachTimelineHandlers();
    attachActivityHandlers(view);
}

// Click an activity row → toggle a file list underneath. Click a file
// in the list → open the markdown viewer for that document.
function attachActivityHandlers(view) {
    view.querySelectorAll('.activity-row[data-files]').forEach(row => {
        row.addEventListener('click', (e) => {
            // Don't toggle if clicking a file link inside the expanded list.
            if (e.target.closest('.activity-files')) return;

            // Toggle the file list.
            const existing = row.querySelector('.activity-files');
            if (existing) { existing.remove(); return; }

            let files;
            try { files = JSON.parse(row.dataset.files); } catch { return; }
            if (!files.length) return;

            const div = document.createElement('div');
            div.className = 'activity-files';
            files.forEach(f => {
                const a = document.createElement('a');
                a.textContent = f;
                a.dataset.file = f;
                a.addEventListener('click', (e2) => {
                    e2.stopPropagation();
                    // Resolve the file path to an IRI and open the markdown viewer.
                    openFileByPath(f);
                });
                div.appendChild(a);
            });
            row.appendChild(div);
        });
    });
}

// Open the markdown viewer for a file by its relative path (e.g. "friend/rob.md").
// Resolves the path to an IRI via SPARQL, then calls openMarkdownViewer.
async function openFileByPath(path) {
    // Doc IRIs derive from repo paths (nothing is invented — universal law),
    // so path→IRI resolution is a suffix match on the IRI itself in the now
    // view. fm:path is gone under one-graph.
    const esc = path.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const rows = await sparql(`
        SELECT ?s ?name WHERE {
            GRAPH <${NOW_GRAPH}> {
                ?s a ?type .
                FILTER(STRENDS(STR(?s), "${esc}"))
                OPTIONAL { ?s <${GL_NAME}> ?name }
            }
        } LIMIT 1
    `);
    if (!rows.length) return;
    const node = { id: rows[0].s, label: rows[0].name || path };
    openMarkdownViewer(node);
}

async function loadRepoInfo() {
    const info = { name: '', kit: '', version: '', created: '', commits: 0, docs: 0, totalTriples: 0 };

    // Read repo metadata from the git-lex:Repo node (NamedGraph/repo —
    // genesisSha + one property per repo.yml key, rebuilt each sync).
    const meta = await sparql(`
        PREFIX gl: <https://repolex.ai/ontology/git-lex/>
        SELECT ?repo ?name ?kit ?version ?created ?genesis WHERE {
            ?repo a gl:Repo .
            OPTIONAL { ?repo gl:name ?name }
            OPTIONAL { ?repo gl:kit ?kit }
            OPTIONAL { ?repo gl:version ?version }
            OPTIONAL { ?repo gl:created ?created }
            OPTIONAL { ?repo gl:genesisSha ?genesis }
        } LIMIT 1
    `);
    if (meta[0]) {
        info.name = meta[0].name || '';
        info.kit = meta[0].kit || '';
        info.version = meta[0].version || '';
        info.created = meta[0].created || '';
        info.repoUri = meta[0].repo || '';
        info.genesis = meta[0].genesis || '';
    }
    // No fallback path: commit IRIs are repo-independent under one-graph
    // (git-lex/git2/Commit/<sha>) so nothing can be derived from them, and
    // the Repo node is rebuilt every sync — if it's missing, sync hasn't run.

    // Count commits
    const commits = await sparql(`
        PREFIX g2: <https://repolex.ai/ontology/git-lex/git2/>
        SELECT (COUNT(?c) AS ?n) WHERE {
            GRAPH <${COMMITS_GRAPH}> { ?c a g2:Commit }
        }
    `);
    if (commits[0]) info.commits = parseInt(commits[0].n) || 0;

    // Count distinct documents. A document is typed TWICE in the now view —
    // once as its File and once as its kit Thing — so counting typed subjects
    // counts most documents twice. On this repo that reported 198 documents
    // against 146 markdown files actually tracked in git: a headline number
    // that cannot be true. Fold each Thing onto its File first, the same
    // collapse the graph view does, and the count becomes 126.
    const docs = await sparql(`
        PREFIX gl: <https://repolex.ai/ontology/git-lex/>
        SELECT (COUNT(DISTINCT ?doc) AS ?n) WHERE {
            GRAPH <${NOW_GRAPH}> {
                ?d a ?type .
                OPTIONAL { ?d gl:fileId ?f }
                BIND(COALESCE(?f, ?d) AS ?doc)
            }
        }
    `);
    if (docs[0]) info.docs = parseInt(docs[0].n) || 0;

    // Total triples
    const total = await sparql(`SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }`);
    if (total[0]) info.totalTriples = parseInt(total[0].n) || 0;

    return info;
}

// Types that exist in the store but should NOT appear as Overview cards.
// - lex-upper/Document is the generic untyped-document fallback; retired by
//   the re-anchor but still present in not-yet-migrated stores — keep the
//   filter until the whole fleet re-anchors, then remove
// - RDF/OWL/SHACL meta types are infrastructure
const HIDDEN_TYPE_PREFIXES = [
    'https://repolex.ai/ontology/lex-upper/',
    'https://repolex.ai/ontology/lex-o/',
    'http://www.w3.org/2002/07/owl',
    'http://www.w3.org/2000/01/rdf-schema',
    'http://www.w3.org/1999/02/22-rdf-syntax-ns',
    'http://www.w3.org/ns/shacl',
];

const FM_TITLE = 'https://repolex.ai/ontology/git-lex/fm/title';
const GL_NS = 'https://repolex.ai/ontology/git-lex/';
const G2_NS = 'https://repolex.ai/ontology/git-lex/git2/';
const GL_NAME = GL_NS + 'name';

// The one-graph store shape (subtexture docs/git-lex/2026_07_21_ONE_GRAPH_AS_
// SHIPPED.md). These graph IRIs are the same in every git-lex repo on earth —
// no per-repo derivation needed.
const ONE_GRAPH     = 'https://repolex.ai/git-lex/LexHistoryGraph';
const NOW_GRAPH     = 'https://repolex.ai/git-lex/NamedGraph/now';
const COMMITS_GRAPH = 'https://repolex.ai/git-lex/NamedGraph/commits';

// Re-anchored File subject base: FILE_BASE + uri-encoded repo-relative path.
const FILE_BASE = 'https://repolex.ai/git-lex/File/';

// Per-type label predicate. Returned in priority order — first one that has
// values for the subject wins. Falls back to gl:name / fm:title, then
// shortName(IRI).
const LABEL_PREDICATES = {
    [G2_NS + 'Commit']:     G2_NS + 'summary',
    [G2_NS + 'IndexEntry']: G2_NS + 'path',
    [G2_NS + 'Branch']:     G2_NS + 'shorthand',
    [GL_NS + 'Repo']:       GL_NAME,
};

function isHiddenType(uri) {
    return HIDDEN_TYPE_PREFIXES.some(p => uri.startsWith(p));
}

async function loadClassCounts() {
    // Walk every type with at least one instance — kit, git layer, anything.
    // Scoped to the frontmatter named graph to avoid the cross-graph union
    // dup that inflates counts elsewhere. Hide infrastructure / placeholder
    // types via HIDDEN_TYPE_PREFIXES.
    const rows = await sparql(`
        SELECT ?type (COUNT(DISTINCT ?s) AS ?count) WHERE {
            GRAPH ?g { ?s a ?type . }
            FILTER(STRENDS(STR(?g), "/now"))
        }
        GROUP BY ?type
        ORDER BY DESC(?count)
    `);

    const classes = [];
    for (const row of rows) {
        const uri = row.type;
        if (!uri || isHiddenType(uri)) continue;

        const count = parseInt(row.count) || 0;
        if (count === 0) continue;

        const labelPred = LABEL_PREDICATES[uri] || FM_TITLE;
        const name = shortName(uri);

        // Sample labels for this class from the now view. gl:name is the
        // canonical label under one-graph; the per-type predicate and
        // fm:title still win where they exist.
        const samples = await sparql(`
            SELECT DISTINCT ?label WHERE {
                GRAPH <${NOW_GRAPH}> {
                    ?s a <${uri}> .
                    { ?s <${labelPred}> ?label } UNION { ?s <${GL_NAME}> ?label }
                }
            }
            ORDER BY ?label
            LIMIT 6
        `);

        let sampleStrs = samples.map(r => (r.label || '').toString().trim()).filter(Boolean);

        // Commit summaries can still be multi-line — keep the first line.
        if (uri === G2_NS + 'Commit') {
            sampleStrs = sampleStrs.map(s => s.split('\n')[0]);
        }
        // IndexEntry paths can be long — show the basename for the sample list.
        if (uri === G2_NS + 'IndexEntry') {
            sampleStrs = sampleStrs.map(s => s.split('/').pop());
        }

        classes.push({
            uri,
            name,
            count,
            samples: sampleStrs,
        });
    }

    return classes;
}

// Load every commit (capped) with its statement-event count, for the history
// scrubber strip. Delta magnitude is now REAL: the number of SpoEvents
// (statements asserted or retracted) each commit produced in the one graph —
// the old git:changed file-count stand-in is retired with the changeset layer.
// Ordering is g2:ordinalDerived, the ordering authority (author dates can tie
// or lie under rebase/amend).
async function loadCommitTimeline() {
    const rows = await sparql(`
        PREFIX gl: <https://repolex.ai/ontology/git-lex/>
        PREFIX g2: <https://repolex.ai/ontology/git-lex/git2/>
        SELECT ?c ?ord ?when ?msg ?author (COUNT(?e) AS ?n) WHERE {
            GRAPH <${COMMITS_GRAPH}> {
                ?c a g2:Commit ; g2:ordinalDerived ?ord ; g2:author ?sig .
                ?sig g2:xsdDateTimeDerived ?when .
                OPTIONAL { ?sig g2:signatureName ?author }
                OPTIONAL { ?c g2:summary ?msg }
            }
            OPTIONAL {
                GRAPH <${ONE_GRAPH}> {
                    { ?e gl:assertedIn ?c } UNION { ?e gl:retractedIn ?c }
                }
            }
        }
        GROUP BY ?c ?ord ?when ?msg ?author
        ORDER BY ?ord
        LIMIT 500
    `);
    return rows.map(r => ({
        sha: (r.c.match(/\/Commit\/([a-f0-9]+)/i) || [])[1] || '',
        uri: r.c,
        date: r.when,
        msg: (r.msg || '').split('\n')[0],
        author: r.author || '',
        n: parseInt(r.n) || 0,
    }));
}

// Render a horizontal SVG timeline strip with one tick per commit.
// Height ∝ delta magnitude. Hover = tooltip. Click = stub for now (will wire
// to /api/scrub when the endpoint lands).
function renderTimeline(commits) {
    if (commits.length === 0) return '';
    const maxN = Math.max(1, ...commits.map(c => c.n));
    const W = 1000;       // viewBox width — scales to container
    const H = 56;
    const padX = 12;
    const padY = 10;
    const trackY = H - padY;
    const trackW = W - padX * 2;
    const span = trackW / Math.max(1, commits.length - 1);

    let bars = '';
    commits.forEach((c, i) => {
        const x = padX + i * span;
        const ratio = c.n / maxN;
        const h = 4 + ratio * (H - padY * 2 - 4);
        const y = trackY - h;
        const w = Math.max(2, Math.min(span * 0.6, 6));
        bars += `<rect class="tl-tick" x="${x - w / 2}" y="${y}" width="${w}" height="${h}" rx="1" data-sha="${c.sha}" data-i="${i}"></rect>`;
    });
    // HEAD marker = the latest commit
    const lastX = padX + (commits.length - 1) * span;
    bars += `<line class="tl-head" x1="${lastX}" y1="${padY - 2}" x2="${lastX}" y2="${trackY + 2}"></line>`;
    bars += `<text class="tl-head-label" x="${lastX}" y="${padY - 4}" text-anchor="middle">HEAD</text>`;

    // Baseline
    bars += `<line class="tl-base" x1="${padX}" y1="${trackY}" x2="${W - padX}" y2="${trackY}"></line>`;

    // Build the data-* JSON for client-side tooltip lookup
    const dataJson = JSON.stringify(commits.map(c => ({
        sha: c.sha.substring(0, 7),
        msg: c.msg.substring(0, 80),
        author: c.author,
        date: c.date,
        n: c.n,
    })));

    return `
        <div class="section timeline-section">
            <div class="section-title">History · ${commits.length} commits · ticks sized by file change count</div>
            <div class="timeline-wrap">
                <svg class="timeline" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
                    ${bars}
                </svg>
                <div class="timeline-tooltip" id="timeline-tooltip" hidden></div>
            </div>
            <div class="timeline-hint">Hover a tick to inspect a commit. Click is a stub — will swap the graph view to that point in time once <code>/api/scrub</code> ships.</div>
            <script type="application/json" id="timeline-data">${escapeHtml(dataJson)}</script>
        </div>
    `;
}

// After loadActivity injects HTML, wire up the timeline interactions.
function attachTimelineHandlers() {
    const dataEl = document.getElementById('timeline-data');
    if (!dataEl) return;
    let commits;
    try { commits = JSON.parse(dataEl.textContent); } catch { return; }
    const tooltip = document.getElementById('timeline-tooltip');
    document.querySelectorAll('.tl-tick').forEach(tick => {
        tick.addEventListener('mouseenter', e => {
            const i = parseInt(tick.dataset.i, 10);
            const c = commits[i];
            if (!c) return;
            tooltip.innerHTML = `
                <div class="tt-msg">${escapeHtml(c.msg)}</div>
                <div class="tt-meta">${escapeHtml(c.author || '')} · ${formatDate(c.date)} · ${c.n} file${c.n === 1 ? '' : 's'} · <code>${c.sha}</code></div>
            `;
            const r = tick.getBoundingClientRect();
            const wrapR = tick.closest('.timeline-wrap').getBoundingClientRect();
            tooltip.style.left = (r.left + r.width / 2 - wrapR.left) + 'px';
            tooltip.style.top = (r.top - wrapR.top - 8) + 'px';
            tooltip.hidden = false;
        });
        tick.addEventListener('mouseleave', () => {
            tooltip.hidden = true;
        });
        tick.addEventListener('click', () => {
            const sha = tick.dataset.sha;
            console.log('[scrub stub] would fetch /api/scrub?commit=' + sha);
            // Visual feedback so the user sees something happen.
            document.querySelectorAll('.tl-tick.active').forEach(t => t.classList.remove('active'));
            tick.classList.add('active');
        });
    });
}

async function loadRecentCommits(limit = 30) {
    // Pull commit-level info first. Recency = DESC ordinal (the ordering
    // authority), not author date.
    const rows = await sparql(`
        PREFIX g2: <https://repolex.ai/ontology/git-lex/git2/>
        SELECT ?c ?msg ?author ?when WHERE {
            GRAPH <${COMMITS_GRAPH}> {
                ?c a g2:Commit ; g2:ordinalDerived ?ord .
                OPTIONAL { ?c g2:summary ?msg }
                OPTIONAL {
                    ?c g2:author ?sig .
                    ?sig g2:xsdDateTimeDerived ?when .
                    OPTIONAL { ?sig g2:signatureName ?author }
                }
            }
        }
        ORDER BY DESC(?ord)
        LIMIT ${limit}
    `);

    if (!rows.length) return [];

    // Pull the statements each commit touched (its SpoEvents in the one
    // graph) and group the touched doc IRIs by commit. This replaces the
    // retired git:changed changeset strings with the real thing.
    const commitUris = rows.map(r => `<${r.c}>`).join(' ');
    const changes = await sparql(`
        PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
        PREFIX gl: <https://repolex.ai/ontology/git-lex/>
        SELECT ?c ?doc WHERE {
            VALUES ?c { ${commitUris} }
            GRAPH <${ONE_GRAPH}> {
                ?e rdf:reifies <<( ?doc ?p ?v )>> .
                { ?e gl:assertedIn ?c } UNION { ?e gl:retractedIn ?c }
            }
        }
    `);

    // Group touched docs by commit. Re-anchored stores use
    // https://repolex.ai/git-lex/File/<uri-encoded repo-relative path>
    // (path verbatim from repo root, extension kept). Pre-re-anchor stores
    // used https://repolex.ai/<repo>/<path>; keep that derivation as the
    // fallback until the whole fleet migrates.
    const byCommit = {};
    changes.forEach(row => {
        const c = row.c;
        const iri = row.doc || '';
        let path;
        if (iri.startsWith(FILE_BASE)) {
            const raw = iri.slice(FILE_BASE.length);
            try { path = decodeURIComponent(raw); } catch { path = raw; }
        } else {
            const segs = iri.replace(/^https?:\/\/[^/]+\//, '').split('/');
            path = segs.slice(1).join('/') || segs.join('/');
        }
        if (!byCommit[c]) byCommit[c] = [];
        if (!byCommit[c].includes(path)) byCommit[c].push(path);
    });

    return rows.map(r => {
        const paths = byCommit[r.c] || [];
        const count = paths.length;
        let hint = '';
        if (count > 0) {
            // Find the most common top-level folder among the touched docs.
            // Skip .lex internal noise so user-visible folders win when present.
            const folderCounts = {};
            paths.forEach(p => {
                if (!p.includes('/')) return; // root files have no folder
                folderCounts[p.split('/')[0]] = (folderCounts[p.split('/')[0]] || 0) + 1;
            });
            // Prefer non-".lex" folders even if .lex has more files.
            const entries = Object.entries(folderCounts);
            const userEntries = entries.filter(([k]) => !k.startsWith('.'));
            const pick = (userEntries.length ? userEntries : entries)
                .sort((a, b) => b[1] - a[1])[0];
            const topFolder = pick ? pick[0] : '';
            hint = `~${count} doc${count === 1 ? '' : 's'}`;
            if (topFolder) hint += ` · ${topFolder}/`;
        }

        return {
            id: r.c,
            message: (r.msg || '').split('\n')[0].substring(0, 100),
            author: r.author || '',
            when: formatDate(r.when),
            changedHint: hint,
            files: paths.filter(p => !p.startsWith('.lex/')).slice(0, 20),
        };
    });
}

function formatDate(iso) {
    if (!iso) return '';
    try {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return iso.substring(0, 10);
        const now = Date.now();
        const diff = now - d.getTime();
        const day = 86400000;
        if (diff < day) return Math.floor(diff / 3600000) + 'h ago';
        if (diff < 30 * day) return Math.floor(diff / day) + 'd ago';
        return d.toISOString().substring(0, 10);
    } catch {
        return iso.substring(0, 10);
    }
}

function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

// ════════════════════════════════════════════
// GRAPH MODE — auto-detected default graph
// ════════════════════════════════════════════

const canvas = document.getElementById('graph-canvas');
const gctx = canvas ? canvas.getContext('2d') : null;
let GW = 0, GH = 0;
let graphState = {
    nodes: [],          // [{ id, label, type, typeColor, x, y, vx, vy, size, file }]
    edges: [],          // [{ source, target, predicate, predicateName, color }]
    classes: [],        // [{ uri, name, color, enabled }]
    predicates: [],     // [{ uri, name, color }]
    selected: null,
    // What the cursor is currently over. Distinct from `selected`: hovering
    // costs the reader nothing and can be undone by moving the mouse, so it
    // is where the graph should answer cheap questions ("what is this one?")
    // without making anyone commit to a click first.
    hovered: null,
    pan: { x: 0, y: 0 },
    zoom: 1,
    drag: null,
    // Neighborhood-focus mode. When focusedNodeIds is non-null, only nodes
    // whose IRI is in the set are shown — turning the whole graph into a
    // localized k-hop view centered on the user's pick.
    focusedNodeIds: null,
    focusedRoot: null,
    focusedHops: 0,
};

const CLASS_PALETTE = [
    '#1f4e8a', '#bb2200', '#2a8a4a', '#aa5500',
    '#7733aa', '#aa6688', '#445577', '#888822',
    '#cc4488', '#226688', '#cc6622', '#558844',
];

// Edges are drawn in subdued versions of these so they don't compete with
// the node fills but stay distinguishable across predicate types.
const EDGE_PALETTE = [
    '#3a3a3a', '#9b3333', '#2f6a3f', '#7a5a1a',
    '#5a3a7a', '#7a4a5a', '#445566', '#666622',
];

function colorForClass(idx) {
    return CLASS_PALETTE[idx % CLASS_PALETTE.length];
}

function colorForEdge(idx) {
    return EDGE_PALETTE[idx % EDGE_PALETTE.length];
}

// Type IRIs we never want to render in the graph at all — RDF infrastructure.
// (kit/none/* phantom classes used to live here too; removed after the
// folder→class strip in git-lex commit 9bf11e2.)
const GRAPH_HIDDEN_TYPES = [
    'http://www.w3.org/2002/07/owl',
    'http://www.w3.org/2000/01/rdf-schema',
    'http://www.w3.org/1999/02/22-rdf-syntax-ns',
    'http://www.w3.org/ns/shacl',
    'https://repolex.ai/ontology/lex-o/',
];

// Types every document gets regardless of what it means. A doc that also
// carries a kit class should render as that class, never as one of these.
// git-lex:File is the re-anchor's replacement for the retired
// lex-upper:Document — same role, so it belongs on the same list. Leaving it
// off is what made every collapsed document a coin flip between its real
// class and a generic gray dot.
const GENERIC_DOC_TYPES = [
    'https://repolex.ai/ontology/lex-upper/',
    'https://repolex.ai/ontology/git-lex/lex/',
    'https://repolex.ai/ontology/git-lex/File',
];

// When a subject has multiple types, pick the most-specific one. Kit classes
// win over the generic every-document fallbacks.
function pickCanonicalType(types) {
    const visible = types.filter(t => !GRAPH_HIDDEN_TYPES.some(p => t.startsWith(p)));
    if (visible.length === 0) return null;
    const specific = visible.find(t => !GENERIC_DOC_TYPES.some(p => t.startsWith(p)));
    return specific || visible[0];
}

// Every relation the store actually HOLDS between two documents — not the ones
// a route remembered to expose. /api/viz/edges returns md:linksTo plus a subset
// of kit object-properties, and on @selkie's soul the subset misses more than
// it carries: 1,394 gl:relatedToId, 376 includesItemId, 298 equippedByBeingId,
// 148 connectsToPlaceId — her entire wardrobe-and-rooms structure — while the
// canvas drew 2,272 chords and looked complete. An allow-list can only fail
// silently. Asking the graph what it holds can only fail out loud, by drawing
// something we then have to explain.
//
// rdf:type, gl:id and gl:fileId are excluded: plumbing, not meaning. Everything
// else with an IRI object is a statement one document makes about another.
async function fetchDocEdges() {
    const rows = await sparql(`
        PREFIX gl: <https://repolex.ai/ontology/git-lex/>
        PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
        SELECT ?from ?predicate ?target WHERE {
            GRAPH <${NOW_GRAPH}> {
                ?from ?predicate ?target .
                FILTER(isIRI(?target))
                FILTER(?predicate != rdf:type &&
                       ?predicate != gl:id &&
                       ?predicate != gl:fileId)
            }
        }
    `).catch(() => null);
    // If the store can't answer, fall back to the route rather than drawing an
    // edgeless graph and calling it a soul with no links.
    if (!rows) {
        return fetch(API + '/api/viz/edges').then(r => r.json())
            .then(d => (d.results || []).map(r => ({ ...r, resolved: r.resolved })))
            .catch(() => []);
    }
    // These come from the now view, which is the resolved half by construction;
    // unresolved links live in md:unresolvedLink and are read separately.
    return rows.map(r => ({ from: r.from, predicate: r.predicate, target: r.target, resolved: 'true' }));
}

// A relation whose edge count dwarfs the number of things it points AT is a fan,
// not a web — 5,071 lookBeingId into 11 Beings says one true thing once and then
// says it five thousand more times over the top of everything else. Callers use
// this to decide what to draw by default; nothing is dropped without being
// counted and named on screen.
const EDGE_FAN_RATIO = 8;
function edgeFanReport(edges) {
    const byPred = new Map();
    edges.forEach(e => {
        let r = byPred.get(e.p || e.predicate);
        if (!r) { r = { count: 0, targets: new Set() }; byPred.set(e.p || e.predicate, r); }
        r.count++; r.targets.add(e.o || e.target);
    });
    const out = new Map();
    byPred.forEach((r, uri) => out.set(uri, { count: r.count, fan: r.count / Math.max(1, r.targets.size) }));
    return out;
}

async function loadGraph() {
    // Render-ready rows from the serve viz routes (Rob's ruling: the data
    // hands structure to the web side — no client-side munging). nodes =
    // every typed doc in the now view INCLUDING orphans, with the display
    // label computed server-side (gl:name when present, else IRI tail).
    // edges = one row per link — md:linksTo plus every kit object-property
    // connecting two docs — as {from, predicate, target, resolved}. `target`
    // is always a string and `resolved` a boolean; the JS branches on the
    // bool column, never on RDF term kinds.
    const [nodeRows, edgeRows, aliasRows, unresolvedRows] = await Promise.all([
        fetch(API + '/api/viz/nodes').then(r => r.json()).then(d => d.results || []).catch(() => []),
        fetchDocEdges(),
        // A document has TWO subjects in the store: the File, which is where
        // body links land, and the Thing, which is where the kit class lands.
        // They are the same document. /api/viz/nodes returns both, and every
        // edge is on the File plane — so without this join every kit-typed
        // node (Note, Journal, Pursuit…) has degree zero BY CONSTRUCTION and
        // renders as disconnected dust. Measured on a 114-commit soul repo:
        // 198 nodes / 107 orphans before, 126 nodes / 35 orphans after, and
        // the 35 that remain are honestly unlinked.
        // gl:fileId is the join and it is complete (72/72 there). Read here
        // rather than server-side so the fix works against binaries already
        // in the wild; if a later api_viz_nodes collapses them itself, this
        // map simply finds nothing to remap and the code is a no-op.
        sparql(`
            PREFIX gl: <https://repolex.ai/ontology/git-lex/>
            PREFIX fm: <https://repolex.ai/ontology/git-lex/fm/>
            SELECT ?thing ?file ?title WHERE {
                GRAPH <${NOW_GRAPH}> {
                    ?thing gl:fileId ?file .
                    OPTIONAL { ?file fm:title ?title }
                }
            }
        `).catch(() => []),
        // Links that point at nothing are NOT dropped — they are demoted to
        // md:unresolvedLink as a literal on the source File. The edges route
        // doesn't read that lane, which is why the dashed dead-end rendering
        // below has never once fired: it was starving, not unnecessary.
        //
        // This is the honest half of the graph. A rename leaves every inbound
        // link pointing at a path that no longer exists, and without this the
        // only symptom is that the repo quietly has fewer edges than it did.
        // Receipt: my own memory index carried a broken link for weeks; the
        // graph knew, and had no way to say so.
        sparql(`
            PREFIX md: <https://repolex.ai/ontology/git-lex/md/>
            SELECT ?s ?v WHERE {
                GRAPH <${NOW_GRAPH}> { ?s md:unresolvedLink ?v }
            }
        `).catch(() => []),
    ]);

    const fileOfThing = {};   // Thing IRI -> the File IRI edges actually use
    const titleOfFile = {};   // File IRI -> frontmatter title, when authored
    aliasRows.forEach(r => {
        if (r.thing && r.file) fileOfThing[r.thing] = r.file;
        if (r.file && r.title) titleOfFile[r.file] = r.title;
    });
    const MD_LINKS_TO = 'https://repolex.ai/ontology/git-lex/md/linksTo';
    // Endpoints go through the SAME join the nodes do. The collapse re-keys
    // every node to its File IRI, so an edge that arrives on the Thing plane
    // — every kit object-property, soul:relatedToPursuitId and its kin —
    // names a subject that is no longer a node id, and the keep-filter below
    // drops it without a word. Node-side remapping alone is half a join:
    // it un-orphaned the Things and then hid the edges that connect them.
    // Found on kira's 6-day soul, where the ONE semantic edge she had
    // authored (Exploration -> Pursuit) never reached the canvas.
    // md:unresolvedLink targets are authored path strings, not IRIs; they
    // find nothing in the map and pass through untouched, which is correct.
    const allEdges = edgeRows.map(r => ({
        s: fileOfThing[r.from] || r.from,
        o: fileOfThing[r.target] || r.target,
        // Fallback keeps compat with a pre-predicate-column server.
        p: r.predicate || MD_LINKS_TO,
        resolved: r.resolved === 'true' || r.resolved === true,
    }));

    // Hold back fan relations — thousands of edges converging on a handful of
    // targets. Drawn, they bury every other relation in the graph and make the
    // force layout meaningless; hidden silently, they are the same failure this
    // whole day has been about. So they are counted, named, and reported in the
    // predicates panel, and the Whole Soul view has a switch to turn each one
    // back on.
    const fanReport = edgeFanReport(allEdges);
    graphState.suppressedPredicates = [];
    const edges = allEdges.filter(e => {
        const r = fanReport.get(e.p);
        if (r && r.fan >= EDGE_FAN_RATIO && r.count > 200) return false;
        return true;
    });
    fanReport.forEach((r, uri) => {
        if (r.fan >= EDGE_FAN_RATIO && r.count > 200) {
            graphState.suppressedPredicates.push({ uri, name: shortName(uri), count: r.count });
        }
    });

    // The demoted links join the same edge list, flagged unresolved. From here
    // they flow through machinery that already existed: they become dead-end
    // stub nodes with dashed edges, so a link to something that isn't there
    // stays VISIBLE instead of being a graph that is quietly two edges smaller.
    const MD_UNRESOLVED = 'https://repolex.ai/ontology/git-lex/md/unresolvedLink';
    unresolvedRows.forEach(r => {
        if (!r.s || !r.v) return;
        edges.push({ s: r.s, o: r.v, p: MD_UNRESOLVED, resolved: false });
    });

    // Group raw rows by subject so we can pick a canonical type (a doc with
    // several types produces one row per type). Thing rows fold onto their
    // File here, which is what makes the two halves one node. Labels are kept
    // per type, not first-row-wins: the row that survives as canonical is the
    // one whose label should show, and which row arrives first is arbitrary.
    const bySubject = {};
    nodeRows.forEach(r => {
        const id = fileOfThing[r.id] || r.id;
        if (!bySubject[id]) bySubject[id] = { id, types: [], labels: {} };
        bySubject[id].types.push(r.type);
        bySubject[id].labels[r.type] = r.label;
    });

    // Resolve canonical type per subject; drop subjects with no visible type.
    const canonical = [];
    for (const s of Object.values(bySubject)) {
        const type = pickCanonicalType(s.types);
        if (!type) continue;
        // An authored frontmatter title beats any derived label — it is the
        // name the author gave the document, and it is the difference between
        // a graph of "2026-04-06-day-of-the-pod.md" and one of "Day of the Pod".
        const raw = titleOfFile[s.id] || s.labels[type] || shortName(s.id);
        // A bare content hash is not a name. soul:soulId is DERIVED — it is the
        // repo's genesis commit SHA, immutable by design — so the Soul node,
        // the one that stands for the person whose graph this is, renders as
        // 40 hex characters on every soul in the fleet. Mine said
        // e3d71e7f0e02… for eight months and I never saw it; @kira saw it on
        // day six, because it was new to her and old to me.
        // The real fix is upstream: nothing in the store carries a Soul's NAME
        // (type, fileId, soulId — that is the whole triple set), because the
        // display name lives in SOUL.md's prose and prose is not extracted.
        // Until the extractor emits one, fall back to the document rather than
        // printing a hash at a reader: "SOUL" says less than "W3BL0RD" and
        // infinitely more than e3d71e7f.
        // Keyed on the SHAPE of the label, never on "equals the genesis SHA"
        // (@w4r3z's note, and he is right): a value test stops firing the day
        // the id scheme changes and says nothing about why, while a shape test
        // degrades honestly — it keeps catching hashes it has never seen, and
        // the worst a false positive can do here is show a document's filename
        // instead of its title.
        const title = /^[0-9a-f]{7,40}$/.test(raw)
            ? shortName(s.id).replace(/\.md$/, '')
            : raw;
        canonical.push({ id: s.id, title, type });
    }

    // Build class palette from canonical types observed in instances.
    const classMap = {};
    canonical.forEach(n => {
        if (!classMap[n.type]) {
            classMap[n.type] = {
                uri: n.type,
                name: shortName(n.type),
                color: colorForClass(Object.keys(classMap).length),
                enabled: true,
                count: 0,
            };
        }
        classMap[n.type].count++;
    });

    // Augment with empty classes from any kit TBox loaded into the store.
    // This is what makes Brief / Pod / Proclamation / Freeform show in the
    // legend even when no instances exist yet — the TBox load (commit 18e5847)
    // puts every kit's owl:Class declarations into a graph we can query.
    // Excludes lex-upper / lex / shacl / rdf / owl meta-classes.
    const tboxClasses = await sparql(`
        PREFIX owl: <http://www.w3.org/2002/07/owl#>
        PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
        SELECT DISTINCT ?cls ?label WHERE {
            GRAPH ?g {
                ?cls a owl:Class .
                OPTIONAL { ?cls rdfs:label ?label }
            }
            FILTER(STRSTARTS(STR(?g), "https://repolex.ai/ontology/kit/"))
        }
    `);
    tboxClasses.forEach(r => {
        if (classMap[r.cls]) return;
        classMap[r.cls] = {
            uri: r.cls,
            name: r.label || shortName(r.cls),
            color: colorForClass(Object.keys(classMap).length),
            enabled: true,
            count: 0,
        };
    });

    graphState.classes = Object.values(classMap).sort((a, b) => a.name.localeCompare(b.name));

    // Build node objects.
    const nodeById = {};
    // Start at CONSTANT DENSITY, not a constant box. 6.4k nodes dropped into
    // the same 400px square that held 130 sit ~5px apart, and a 1/d^2
    // repulsion at 5px is enormous — the first step alone launches them.
    const INITIAL_SPREAD = 400 * Math.max(1, Math.sqrt(canonical.length / 150));
    graphState.nodes = canonical.map(n => {
        const cls = classMap[n.type];
        const node = {
            id: n.id,
            label: n.title || shortName(n.id),
            type: n.type,
            typeName: cls.name,
            color: cls.color,
            x: (Math.random() - 0.5) * INITIAL_SPREAD,
            y: (Math.random() - 0.5) * INITIAL_SPREAD,
            vx: 0, vy: 0,
            size: 6,
            degree: 0,
        };
        nodeById[n.id] = node;
        return node;
    });

    // Unresolved link targets (resolved=false) become dead-end stub nodes
    // with dashed edges — links to docs that aren't there stay VISIBLE
    // instead of being silently dropped. Resolved targets missing from
    // nodeById are cross-graph refs; those still drop.
    // (Wikilinks are retired; these now arrive from md:unresolvedLink, which
    // is where a link goes when its path stops resolving — after a rename,
    // most often. The label is the path as the author actually wrote it.)
    const STUB_CLASS = {
        uri: 'about:unresolved-link', name: '(unresolved link)',
        color: '#555', enabled: true, count: 0,
    };
    edges.filter(e => !e.resolved && e.s !== e.o && !nodeById[e.o]).forEach(e => {
        if (!STUB_CLASS.count) graphState.classes.push(STUB_CLASS);
        STUB_CLASS.count++;
        nodeById[e.o] = {
            id: e.o, label: e.o, type: STUB_CLASS.uri, typeName: STUB_CLASS.name,
            color: STUB_CLASS.color,
            x: (Math.random() - 0.5) * 400, y: (Math.random() - 0.5) * 400,
            vx: 0, vy: 0, size: 5, degree: 0, stub: true,
        };
        graphState.nodes.push(nodeById[e.o]);
    });

    // Build predicate palette from the edges we'll actually keep. Unresolved
    // edges are deliberately excluded: "unresolved" is a STATE a link is in,
    // not a kind of link, and it already reads as one from the dashes and the
    // stub. Letting it into the palette would also silently count as a second
    // predicate and switch every "linksTo" label back on.
    const predicateMap = {};
    edges.forEach(e => {
        if (!e.resolved) return;
        if (!nodeById[e.s] || !nodeById[e.o]) return;
        if (!predicateMap[e.p]) {
            predicateMap[e.p] = {
                uri: e.p,
                name: shortName(e.p),
                color: colorForEdge(Object.keys(predicateMap).length),
            };
        }
    });
    graphState.predicates = Object.values(predicateMap).sort((a, b) => a.name.localeCompare(b.name));

    graphState.edges = edges
        .filter(e => nodeById[e.s] && nodeById[e.o])
        .map(e => {
            nodeById[e.s].degree++;
            nodeById[e.o].degree++;
            // Unresolved edges are not in the palette by design, so there is
            // no entry to read — fall back rather than assume one is there.
            const pred = predicateMap[e.p];
            return {
                source: nodeById[e.s],
                target: nodeById[e.o],
                predicate: e.p,
                predicateName: pred ? pred.name : shortName(e.p),
                color: pred && e.resolved ? pred.color : STUB_CLASS.color,
                dashed: !e.resolved,
            };
        });

    // Size by degree — log curve so high-degree hubs don't dwarf leaves.
    // Min 8 (readable), top ~26 for very high degree. Compressed range
    // keeps the graph visually balanced; W4R3Z-style hubs no longer eat
    // the screen.
    graphState.nodes.forEach(n => {
        n.size = 8 + Math.log2(n.degree + 1) * 4;
    });

    renderGraphControls();
    settleAndAnimate();
}

function renderGraphControls() {
    const classesEl = document.getElementById('graph-classes');
    classesEl.innerHTML = '';
    graphState.classes.forEach(c => {
        const lbl = document.createElement('label');
        lbl.className = 'class-toggle';
        lbl.innerHTML = `
            <input type="checkbox" ${c.enabled ? 'checked' : ''}>
            <span class="swatch" style="background:${c.color}"></span>
            <span>${c.name}</span>
        `;
        const cb = lbl.querySelector('input');
        cb.addEventListener('change', () => {
            c.enabled = cb.checked;
            // Re-run the simulation so the visible nodes spread to fill the
            // freed space (or compress when a class re-enters). Animated.
            kickSimulation();
        });
        classesEl.appendChild(lbl);
    });

    // Predicate legend — read-only swatches showing edge color → predicate.
    const predEl = document.getElementById('graph-predicates');
    if (predEl) {
        predEl.innerHTML = '';
        graphState.predicates.forEach(p => {
            const row = document.createElement('div');
            row.className = 'pred-row';
            row.innerHTML = `
                <span class="pred-swatch" style="background:${p.color}"></span>
                <span>${p.name}</span>
            `;
            predEl.appendChild(row);
        });
        // Anything held back says so, with its count. A hidden relation you can
        // see the size of is a decision; one you can't is a lie.
        (graphState.suppressedPredicates || []).forEach(p => {
            const row = document.createElement('div');
            row.className = 'pred-row pred-row-muted';
            row.title = p.uri + ' — held back: ' + p.count.toLocaleString() +
                ' edges converging on a handful of targets. Whole Soul view has a switch for it.';
            row.innerHTML = `
                <span class="pred-swatch" style="background:transparent;border:1px dotted #999"></span>
                <span>${p.name} <span style="color:#999">${p.count.toLocaleString()} held back</span></span>
            `;
            predEl.appendChild(row);
        });
    }

    document.getElementById('graph-meta').textContent =
        `${graphState.nodes.length} nodes · ${graphState.edges.length} edges`;
}

// Force-layout constants — tuned so graphs of 25-150 nodes spread out enough
// for labels to read without becoming sparse and lost in space.
const LAYOUT = {
    REPULSION: 9000,
    EDGE_REST: 150,
    SPRING_K: 0.06,
    CENTERING: 0.0022,
    ORPHAN_PULL: 0.014,    // extra centering force for degree ≤ 1 nodes
    DAMPING: 0.45,
    STEP: 0.4,
    // Everything below is what it takes to survive a real soul. @selkie's is
    // 6,359 nodes; the constants above were tuned on 25-150 and the comment
    // said so. At 6.4k the all-pairs loop is 40M distance checks per frame AND
    // the forces diverge: measured coordinates of 1.1e50 after nine seconds,
    // which draws as a blank canvas with a correct-looking node count.
    REPULSION_CUTOFF: 320,  // 1/d^2 past this is noise; lets us grid the sum
    MIN_DIST2: 64,          // floor of 1 let coincident nodes fire 9000-unit kicks
    MAX_SPEED: 120,         // hard ceiling per step — the anti-explosion bolt
};

// Run one physics step over the currently-visible nodes/edges.
function stepForceLayout() {
    const enabled = new Set(graphState.classes.filter(c => c.enabled).map(c => c.uri));
    const focused = graphState.focusedNodeIds;
    const nodes = graphState.nodes.filter(n =>
        enabled.has(n.type) && (!focused || focused.has(n.id))
    );
    if (nodes.length === 0) return 0;
    const visIds = new Set(nodes.map(n => n.id));
    const edges = graphState.edges.filter(e => visIds.has(e.source.id) && visIds.has(e.target.id));

    let totalKE = 0;

    // Repulsion, summed over a uniform grid rather than every pair. Cell size
    // IS the cutoff, so the 3x3 neighbourhood around a node contains every
    // other node that could still be pushing on it. Small graphs land in one
    // or two cells and behave exactly as they did before.
    const CUT = LAYOUT.REPULSION_CUTOFF;
    const CUT2 = CUT * CUT;
    const grid = new Map();
    for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const k = Math.floor(n.x / CUT) + ',' + Math.floor(n.y / CUT);
        const bucket = grid.get(k);
        if (bucket) bucket.push(n); else grid.set(k, [n]);
    }

    for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        let fx = 0, fy = 0;
        const cx = Math.floor(a.x / CUT);
        const cy = Math.floor(a.y / CUT);
        for (let ox = -1; ox <= 1; ox++) {
            for (let oy = -1; oy <= 1; oy++) {
                const bucket = grid.get((cx + ox) + ',' + (cy + oy));
                if (!bucket) continue;
                for (let j = 0; j < bucket.length; j++) {
                    const b = bucket[j];
                    if (b === a) continue;
                    const dx = a.x - b.x;
                    const dy = a.y - b.y;
                    let dist2 = dx * dx + dy * dy;
                    if (dist2 > CUT2) continue;
                    dist2 = Math.max(dist2, LAYOUT.MIN_DIST2);
                    const dist = Math.sqrt(dist2);
                    // Bigger nodes push harder so hubs don't stack on each other.
                    const sizeBoost = (a.size + b.size) / 24;
                    const force = LAYOUT.REPULSION * sizeBoost / dist2;
                    fx += (dx / dist) * force;
                    fy += (dy / dist) * force;
                }
            }
        }
        // Centering. Low-degree nodes (orphans + one-edge leaves) get a
        // stronger pull so they don't drift off-screen.
        const center = a.degree <= 1 ? LAYOUT.ORPHAN_PULL : LAYOUT.CENTERING;
        fx -= a.x * center;
        fy -= a.y * center;
        a.vx = (a.vx + fx) * LAYOUT.DAMPING;
        a.vy = (a.vy + fy) * LAYOUT.DAMPING;
    }

    // Spring attraction
    edges.forEach(e => {
        const dx = e.target.x - e.source.x;
        const dy = e.target.y - e.source.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const displacement = dist - LAYOUT.EDGE_REST;
        const force = LAYOUT.SPRING_K * displacement;
        const ux = dx / dist;
        const uy = dy / dist;
        e.source.vx += ux * force;
        e.source.vy += uy * force;
        e.target.vx -= ux * force;
        e.target.vy -= uy * force;
    });

    // Integrate, with a speed ceiling. A hub with 123 edges accumulates 123
    // spring forces in one step; unclamped, one bad frame throws it far enough
    // that the next frame's springs are worse, and the graph leaves the
    // universe in about ten frames. Clamping costs a little settling speed and
    // buys the guarantee that a big graph draws SOMETHING.
    const MAX2 = LAYOUT.MAX_SPEED * LAYOUT.MAX_SPEED;
    graphState.nodes.forEach(n => {
        const sp2 = n.vx * n.vx + n.vy * n.vy;
        if (sp2 > MAX2) {
            const scale = LAYOUT.MAX_SPEED / Math.sqrt(sp2);
            n.vx *= scale;
            n.vy *= scale;
        }
        n.x += n.vx * LAYOUT.STEP;
        n.y += n.vy * LAYOUT.STEP;
        totalKE += n.vx * n.vx + n.vy * n.vy;
    });

    return totalKE;
}

// Continuous animation loop. Steps the simulation each frame as long as the
// system has measurable kinetic energy. Class-toggle changes call kickSimulation()
// to restart the loop.
let _layoutRAF = null;
let _layoutEnergy = 0;
// Higher floor = settles faster, less "cutesy floaty drift". The graph
// locks in once it's good enough rather than forever-jiggling.
const ENERGY_FLOOR = 8;
// Kinetic energy is a SUM over nodes, so a fixed floor is really a per-node
// floor that shrinks as the graph grows: 6.4k nodes idling at a jiggle never
// drop under 8, so the settle branch never runs, so the graph never recenters
// and never auto-fits. Scale the floor with the node count and "settled" means
// the same thing at every size.
function energyFloor() {
    return Math.max(ENERGY_FLOOR, graphState.nodes.length * 0.05);
}

function animateLayout() {
    _layoutRAF = null;
    const ke = stepForceLayout();
    _layoutEnergy = _layoutEnergy * 0.9 + ke * 0.1;
    drawGraph();
    if (_layoutEnergy > energyFloor()) {
        _layoutRAF = requestAnimationFrame(animateLayout);
    } else {
        // Settled — recenter so the graph sits at world origin regardless of
        // any drift during simulation, then auto-fit zoom so the whole
        // graph fills the viewport with margin.
        recenterGraph();
        fitGraphToViewport();
        drawGraph();
    }
}

function recenterGraph() {
    const ns = graphState.nodes;
    if (ns.length === 0) return;
    let sx = 0, sy = 0;
    ns.forEach(n => { sx += n.x; sy += n.y; });
    const cx = sx / ns.length;
    const cy = sy / ns.length;
    ns.forEach(n => { n.x -= cx; n.y -= cy; });
}

// After settle: pick a zoom level that makes the whole graph fit in the
// viewport with comfortable margin. Auto-fits only if user hasn't manually
// zoomed (graphState.userZoomed flag).
function fitGraphToViewport() {
    const ns = graphState.nodes;
    if (ns.length === 0 || !GW || !GH) return;
    if (graphState.userZoomed) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    ns.forEach(n => {
        minX = Math.min(minX, n.x - n.size);
        maxX = Math.max(maxX, n.x + n.size);
        minY = Math.min(minY, n.y - n.size);
        maxY = Math.max(maxY, n.y + n.size);
    });
    const w = maxX - minX;
    const h = maxY - minY;
    if (w <= 0 || h <= 0) return;
    // Margin: 10% on each side, plus space for node labels under each node.
    const margin = 0.85;
    const zoomX = (GW * margin) / w;
    const zoomY = (GH * margin) / h;
    graphState.zoom = Math.max(0.2, Math.min(2.5, Math.min(zoomX, zoomY)));
    graphState.pan.x = 0;
    graphState.pan.y = 0;
}

function kickSimulation() {
    _layoutEnergy = 100;            // pretend we're hot so the loop keeps going
    if (_layoutRAF == null) {
        _layoutRAF = requestAnimationFrame(animateLayout);
    }
}

// Initial settle: warm-start by running a chunk of frames synchronously so
// the user doesn't see the graph fly together for too long, then hand off
// to the animator for the final settle.
function settleAndAnimate() {
    // Heavy warm-start: do most of the settling synchronously so the user
    // sees a (mostly) stable graph on first paint instead of watching it
    // crawl into place over a few seconds.
    // Warm-start steps cost O(nodes) each now, not O(nodes^2), but 350 of them
    // on a 6k graph is still seconds of frozen tab before first paint. Spend a
    // fixed work budget instead: small graphs get the full settle, big ones get
    // a head start and finish under the animator where the user can watch.
    const warm = Math.max(60, Math.min(350, Math.floor(500000 / graphState.nodes.length)));
    for (let i = 0; i < warm; i++) stepForceLayout();
    recenterGraph();
    fitGraphToViewport();
    kickSimulation();
}

function resizeGraph() {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    GW = rect.width;
    GH = rect.height;
    canvas.width = GW * devicePixelRatio;
    canvas.height = GH * devicePixelRatio;
    canvas.style.width = GW + 'px';
    canvas.style.height = GH + 'px';
    gctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    drawGraph();
}

function drawGraph() {
    if (!gctx || !canvas.width) return;
    gctx.clearRect(0, 0, GW, GH);

    const enabled = new Set(graphState.classes.filter(c => c.enabled).map(c => c.uri));
    const focused = graphState.focusedNodeIds;
    const visibleNodes = graphState.nodes.filter(n =>
        enabled.has(n.type) && (!focused || focused.has(n.id))
    );
    const visibleNodeIds = new Set(visibleNodes.map(n => n.id));

    gctx.save();
    gctx.translate(GW / 2 + graphState.pan.x, GH / 2 + graphState.pan.y);
    gctx.scale(graphState.zoom, graphState.zoom);

    const selId = graphState.selected;
    // When something is selected, edges that don't touch it dim to give
    // focus to the selection's neighborhood.
    const dimOthers = selId != null;

    // Edges — colored by predicate, with a small arrow at the target end.
    const edgeWidth = Math.max(1.2, 1.6 / graphState.zoom);
    graphState.edges.forEach(e => {
        if (!visibleNodeIds.has(e.source.id) || !visibleNodeIds.has(e.target.id)) return;
        const touchesSel = !dimOthers || e.source.id === selId || e.target.id === selId;
        gctx.strokeStyle = touchesSel ? e.color : 'rgba(180,180,180,0.35)';
        gctx.fillStyle = gctx.strokeStyle;
        gctx.lineWidth = edgeWidth;

        // Compute the segment that ends at the target node's edge (not its
        // center) so the arrow head sits cleanly outside the disc.
        const dx = e.target.x - e.source.x;
        const dy = e.target.y - e.source.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const ux = dx / dist;
        const uy = dy / dist;
        const sx = e.source.x + ux * e.source.size;
        const sy = e.source.y + uy * e.source.size;
        const tx = e.target.x - ux * e.target.size;
        const ty = e.target.y - uy * e.target.size;

        // Unresolved-link edges render dashed (dead-end stubs).
        if (e.dashed) gctx.setLineDash([4, 3]);
        gctx.beginPath();
        gctx.moveTo(sx, sy);
        gctx.lineTo(tx, ty);
        gctx.stroke();
        if (e.dashed) gctx.setLineDash([]);

        // Arrow head — simple filled triangle pointing along (ux, uy).
        const ah = Math.max(6, 8 / graphState.zoom);
        const aw = ah * 0.55;
        const px = -uy;
        const py = ux;
        gctx.beginPath();
        gctx.moveTo(tx, ty);
        gctx.lineTo(tx - ux * ah + px * aw, ty - uy * ah + py * aw);
        gctx.lineTo(tx - ux * ah - px * aw, ty - uy * ah - py * aw);
        gctx.closePath();
        gctx.fill();
    });

    // Edge labels — predicate names at midpoint, rotated to follow the edge.
    // Only draw when zoomed in enough to read, and skip very short edges so
    // dense clusters don't drown in text.
    //
    // And only when there is more than one predicate to tell apart. A soul
    // repo is 130 out of 130 edges md:linksTo — writing "linksTo" 130 times
    // distinguishes nothing, it just prints the same word across the picture.
    // A label earns its ink by answering "which kind?", so when there is only
    // one kind it has no question to answer.
    if (graphState.zoom > 0.7 && graphState.predicates.length > 1) {
        // Constant on-screen size: 11px regardless of zoom. The canvas has
        // a `gctx.scale(zoom, zoom)` in effect, so we counter-divide.
        const labelPx = 11 / graphState.zoom;
        gctx.font = `600 ${labelPx}px 'American Typewriter', Courier, monospace`;
        gctx.textAlign = 'center';
        gctx.textBaseline = 'middle';
        graphState.edges.forEach(e => {
            if (!visibleNodeIds.has(e.source.id) || !visibleNodeIds.has(e.target.id)) return;
            const touchesSel = !dimOthers || e.source.id === selId || e.target.id === selId;
            if (dimOthers && !touchesSel) return;
            const dx = e.target.x - e.source.x;
            const dy = e.target.y - e.source.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            if (dist < 60) return;
            const mx = (e.source.x + e.target.x) / 2;
            const my = (e.source.y + e.target.y) / 2;
            // Keep text upright: flip if the edge points left-to-right backwards.
            let angle = Math.atan2(dy, dx);
            if (angle > Math.PI / 2) angle -= Math.PI;
            if (angle < -Math.PI / 2) angle += Math.PI;
            gctx.save();
            gctx.translate(mx, my);
            gctx.rotate(angle);
            // Background pad so the label doesn't fight the edge stroke
            const text = e.predicateName || '';
            const tw = gctx.measureText(text).width;
            gctx.fillStyle = 'rgba(255,255,255,0.85)';
            gctx.fillRect(-tw / 2 - 2, -labelPx / 2 - 1, tw + 4, labelPx + 2);
            gctx.fillStyle = e.color;
            gctx.fillText(text, 0, 0);
            gctx.restore();
        });
    }

    // Neighbours of the selection, resolved once. This used to be a full edge
    // scan per node inside the draw loop — O(nodes × edges) every frame.
    const neighborIds = new Set();
    if (dimOthers) {
        graphState.edges.forEach(e => {
            if (e.source.id === selId) neighborIds.add(e.target.id);
            if (e.target.id === selId) neighborIds.add(e.source.id);
        });
    }

    // Nodes
    visibleNodes.forEach(n => {
        const isSelected = selId === n.id;
        const isNeighbor = dimOthers && !isSelected && neighborIds.has(n.id);
        const isFocused = !dimOthers || isSelected || isNeighbor;
        const isHovered = graphState.hovered === n.id;
        gctx.globalAlpha = isFocused ? 1 : 0.3;
        gctx.beginPath();
        gctx.arc(n.x, n.y, n.size, 0, Math.PI * 2);
        gctx.fillStyle = n.color;
        gctx.fill();
        // Selection is a committed state and gets the heavy black ring.
        // Hover is provisional, so it gets a lighter one — the difference in
        // weight is the difference between "this is where you are" and "this
        // is what you'd get".
        gctx.strokeStyle = isSelected ? '#000' : (isHovered ? '#000' : '#ffffff');
        gctx.lineWidth = (isSelected ? 2.5 : isHovered ? 1.8 : 1.4) / graphState.zoom;
        gctx.stroke();
    });
    gctx.globalAlpha = 1;

    // Labels. Drawing one per node put ~80 overlapping strings in the middle
    // of this repo's graph — the text stopped being readable AND stopped the
    // shape underneath from being readable, so it cost twice what it paid.
    // A map doesn't label every town at every zoom; it labels what you asked
    // for and what's big, and it never lets two labels overlap. Same rules:
    //   1. always label the selection and its neighbours — that's the answer
    //      to a question the reader just asked, so it outranks everything
    //   2. otherwise label in descending degree, so hubs win contested space
    //   3. skip any label that would collide with one already placed
    // Zooming in frees space and more names appear, which makes the zoom a
    // way of reading rather than just a way of magnifying.
    if (graphState.zoom > 0.5) {
        const labelPx = 11 / graphState.zoom;
        gctx.font = `${labelPx}px 'American Typewriter', Courier, monospace`;
        gctx.textAlign = 'center';
        gctx.textBaseline = 'top';

        const ordered = visibleNodes.slice().sort((a, b) => b.degree - a.degree);
        const placed = [];
        const pad = 2 / graphState.zoom;

        ordered.forEach(n => {
            const isSelected = selId === n.id;
            const isNeighbor = dimOthers && neighborIds.has(n.id);
            const asked = isSelected || isNeighbor || n.id === graphState.hovered;
            // When a selection is active the rest of the graph is context,
            // not content — don't re-clutter it with names.
            if (!asked && dimOthers) return;
            if (!asked && n.degree === 0 && graphState.zoom < 1.4) return;

            const lbl = n.label.length > 22 ? n.label.substring(0, 20) + '…' : n.label;
            const w = gctx.measureText(lbl).width;
            const x = n.x - w / 2;
            const y = n.y + n.size + 2;
            const box = { x1: x - pad, y1: y - pad, x2: x + w + pad, y2: y + labelPx + pad };

            if (!asked && placed.some(p =>
                box.x1 < p.x2 && box.x2 > p.x1 && box.y1 < p.y2 && box.y2 > p.y1)) return;
            placed.push(box);

            // A label sits on top of edges, so give it a little air.
            gctx.fillStyle = 'rgba(255,255,255,0.82)';
            gctx.fillRect(box.x1, box.y1, box.x2 - box.x1, box.y2 - box.y1);
            gctx.fillStyle = asked ? '#000' : '#222';
            gctx.fillText(lbl, n.x, y);
        });
    }

    gctx.restore();
}

function focusClassInGraph(cls) {
    graphState.classes.forEach(c => c.enabled = (c.uri === cls));
    renderGraphControls();
    kickSimulation();
}

// BFS k-hop neighborhood through already-loaded edges. Returns a Set of node
// IRIs reachable within `hops` steps from the root, including the root.
function neighborhoodIds(rootId, hops) {
    const found = new Set([rootId]);
    let frontier = new Set([rootId]);
    for (let h = 0; h < hops; h++) {
        const next = new Set();
        graphState.edges.forEach(e => {
            if (frontier.has(e.source.id) && !found.has(e.target.id)) {
                next.add(e.target.id);
                found.add(e.target.id);
            }
            if (frontier.has(e.target.id) && !found.has(e.source.id)) {
                next.add(e.source.id);
                found.add(e.source.id);
            }
        });
        if (next.size === 0) break;
        frontier = next;
    }
    return found;
}

function focusNeighborhood(rootId, hops) {
    graphState.focusedNodeIds = neighborhoodIds(rootId, hops);
    graphState.focusedRoot = rootId;
    graphState.focusedHops = hops;
    // Refresh detail panel so the focus controls update.
    const root = graphState.nodes.find(n => n.id === rootId);
    if (root) showNodeDetail(root);
    kickSimulation();
}

// ════════════════════════════════════════════
// MARKDOWN VIEWER PANE
// ════════════════════════════════════════════
//
// Double-click any neighbor link in the detail panel (or any node on the
// canvas) → opens a second card to the left of the detail card showing the
// rendered markdown of that node's underlying file.
//
// Contract: GET /api/file?uri=<encoded-iri> returns
// { content: string, frontmatter?: string } as JSON, or
// { error: string } when the IRI isn't resolvable in this store
// (e.g. cross-repo references whose target file isn't extracted here).

function openMarkdownViewer(node) {
    const viewer = document.getElementById('graph-md-viewer');
    if (!viewer || !node) return;
    viewer.hidden = false;

    const url = '/api/file?uri=' + encodeURIComponent(node.id);
    viewer.innerHTML = `
        <div class="md-header">
            <h3 class="md-title">${escapeHtml(node.label)}</h3>
            <button class="md-close" aria-label="Close">×</button>
        </div>
        <div class="md-body"><div class="md-loading">loading…</div></div>
    `;
    viewer.querySelector('.md-close').addEventListener('click', closeMarkdownViewer);

    fetch(url)
        .then(r => {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        })
        .then(data => {
            // /api/file returns 200 with {error: "…"} when the IRI isn't in
            // the store (e.g. "no git2:path for this IRI"). The !r.ok check
            // above doesn't catch that, so we'd silently render an empty
            // body. Surface the error via the same stub path that HTTP
            // errors take.
            if (data && data.error) throw new Error(data.error);
            renderMarkdownInto(viewer, data, node);
        })
        .catch(err => renderMarkdownStub(viewer, node, err));
}

function closeMarkdownViewer() {
    const viewer = document.getElementById('graph-md-viewer');
    if (viewer) viewer.hidden = true;
}

function renderMarkdownInto(viewer, data, node) {
    const body = viewer.querySelector('.md-body');
    const fm = data.frontmatter ? `<div class="md-fm">${escapeHtml(data.frontmatter)}</div>` : '';
    const html = renderMarkdown(data.content || '');
    body.innerHTML = fm + html;
    attachWikilinkHandlers(body);
}

// Resolve a wikilink target string (e.g. "w4r3z", "project/git-lex",
// "pod-3") to a document IRI + display label via SPARQL. Strategy:
//   1. Ends-with match on the doc IRI (IRIs derive from repo paths, so
//      this handles both "project/git-lex" and bare "w4r3z")
//   2. Exact label match on gl:name (canonical one-graph label)
//   3. Exact title match on fm:title (prose-case wikilinks)
// First hit wins. Returns { id, label } or null.
async function resolveWikilink(target) {
    if (!target) return null;
    // Normalize: trim, drop trailing .md if the user wrote one.
    let t = target.trim();
    t = t.replace(/\.md$/i, '');
    // Double-quote-safe literal: the extractor normalizes slugs to ascii
    // but body wikilinks can carry arbitrary prose. Escape any embedded
    // quotes and backslashes before interpolating into the SPARQL literal.
    const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const pathWithMd = esc(t + '.md');
    const titleLit = esc(t);

    // Doc IRIs derive from repo paths, so the path arm matches the IRI tail
    // directly (fm:path is gone under one-graph). Label arms: gl:name is the
    // canonical label; fm:title survives for title-carrying frontmatter.
    const query = `
        PREFIX gl: <https://repolex.ai/ontology/git-lex/>
        PREFIX fm: <https://repolex.ai/ontology/git-lex/fm/>
        SELECT ?s ?label WHERE {
            GRAPH <${NOW_GRAPH}> {
                {
                    ?s a ?type .
                    FILTER(STRENDS(LCASE(STR(?s)), LCASE("/${pathWithMd}")))
                    OPTIONAL { ?s gl:name ?n }
                    BIND(COALESCE(?n, "${titleLit}") AS ?label)
                } UNION {
                    ?s gl:name ?name .
                    FILTER(LCASE(STR(?name)) = LCASE("${titleLit}"))
                    BIND(?name AS ?label)
                } UNION {
                    ?s fm:title ?title .
                    FILTER(LCASE(STR(?title)) = LCASE("${titleLit}"))
                    BIND(?title AS ?label)
                }
            }
        } LIMIT 1`;

    try {
        const rows = await sparql(query);
        if (!Array.isArray(rows) || !rows.length) return null;
        const r = rows[0];
        return { id: r.s, label: r.label || target };
    } catch (e) {
        return null;
    }
}

// Wire dblclick handlers on any .wikilink elements in a freshly-rendered
// markdown body. Resolver is async; while it runs we mark the element
// data-wl-state="resolving" so CSS can hint progress; on success we jump
// graph selection (if the target is already in the current graph view)
// and open a new markdown viewer for the resolved document.
function attachWikilinkHandlers(body) {
    const links = body.querySelectorAll('a.wikilink');
    links.forEach(a => {
        a.style.cursor = 'pointer';
        a.title = 'double-click to open';
        a.addEventListener('dblclick', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const target = a.dataset.wikilink;
            if (!target) return;
            if (a.dataset.wlState === 'resolving') return;
            a.dataset.wlState = 'resolving';
            const resolved = await resolveWikilink(target);
            if (!resolved) {
                a.dataset.wlState = 'unresolved';
                a.title = `could not resolve [[${target}]]`;
                return;
            }
            a.dataset.wlState = 'resolved';
            // If the resolved IRI matches a node in the active graph view,
            // update selection + refresh the detail card + redraw so the
            // focus follows the user into the target document.
            if (typeof graphState !== 'undefined' && Array.isArray(graphState.nodes)) {
                const hit = graphState.nodes.find(n => n.id === resolved.id);
                if (hit) {
                    graphState.selected = hit.id;
                    if (typeof showNodeDetail === 'function') showNodeDetail(hit);
                    if (typeof drawGraph === 'function') drawGraph();
                }
            }
            openMarkdownViewer({ id: resolved.id, label: resolved.label });
        });
    });
}

function renderMarkdownStub(viewer, node, err) {
    const body = viewer.querySelector('.md-body');
    const msg = (err && err.message) || '';
    // /api/file returns { error: "no <path-predicate> for this IRI" } when
    // the IRI is referenced from this store but the underlying file isn't
    // extracted here (typical: cross-repo wikilink target — the squad
    // referenced this doc, but the squad's repo isn't cloned alongside this
    // soul). Match the stable suffix, not the predicate name — the path
    // predicate moved fm:path → git2:path across the one-graph cutover.
    const isCrossRepo = /no [^ ]+ for this IRI/.test(msg);
    if (isCrossRepo) {
        body.innerHTML = `
            <div class="md-error">file not in this store</div>
            <div class="md-stub-note">
                This entity is referenced from this repo (e.g. via a wikilink
                or squad relation), but the file itself lives in another repo
                that isn't extracted here. Clone the source repo alongside this
                one and re-sync to make it browsable.
                <br><br>
                URI: <code>${escapeHtml(node.id)}</code>
            </div>
        `;
        return;
    }
    // Real backend / network failure.
    body.innerHTML = `
        <div class="md-error">file viewer unavailable</div>
        <div class="md-stub-note">
            Couldn't fetch the file from <code>/api/file</code>. The viz
            server may be stopped or unreachable.
            <br><br>
            URI: <code>${escapeHtml(node.id)}</code>
            <br><br>
            <span style="color:#bbb;font-size:0.6rem">${escapeHtml(msg)}</span>
        </div>
    `;
}

// Tiny markdown renderer — handles the subset of CommonMark we actually use
// in git-lex notes (headings, paragraphs, lists, code blocks, inline code,
// bold, italic, links, blockquotes). Not a full parser; the goal is "good
// enough to read your own notes," not "render arbitrary GFM."
function renderMarkdown(src) {
    if (!src) return '';
    // Strip a leading YAML frontmatter block if the server didn't already.
    let body = src;
    const fmMatch = body.match(/^---\n([\s\S]*?)\n---\n?/);
    if (fmMatch) body = body.slice(fmMatch[0].length);

    // Pull out fenced code blocks first so we don't apply inline rules inside.
    const codeBlocks = [];
    body = body.replace(/```([a-z]*)\n([\s\S]*?)```/g, (m, lang, code) => {
        codeBlocks.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
        return `\u0000CODE${codeBlocks.length - 1}\u0000`;
    });

    // Pull out wikilinks before inline/escape processing so the raw target can
    // survive into the attribute. Re-inserted as placeholder tokens that the
    // inline() pipeline passes through untouched, then substituted at the end
    // with a data-wikilink attr carrying the unescaped target for the runtime
    // resolver to use.
    const wikilinks = [];
    body = body.replace(/\[\[([^\]]+)\]\]/g, (m, target) => {
        wikilinks.push(target);
        return `\u0000WL${wikilinks.length - 1}\u0000`;
    });

    const inline = (s) => {
        s = escapeHtml(s);
        // Inline code (after escaping so backticks survive)
        s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
        // Bold then italic (order matters)
        s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
        s = s.replace(/_([^_]+)_/g, '<em>$1</em>');
        // Markdown links [text](url)
        s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
        // Restore wikilink placeholders with proper data-wikilink attribute.
        // Target is used both as the visible text and as the resolver key.
        s = s.replace(/\u0000WL(\d+)\u0000/g, (_, idx) => {
            const target = wikilinks[parseInt(idx)];
            const attr = target.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
            return `<a class="wikilink" data-wikilink="${attr}">${escapeHtml(target)}</a>`;
        });
        return s;
    };

    const lines = body.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];

        // Code block placeholder
        const cbMatch = line.match(/^\u0000CODE(\d+)\u0000$/);
        if (cbMatch) { out.push(codeBlocks[parseInt(cbMatch[1])]); i++; continue; }

        // Headings
        const h = line.match(/^(#{1,6})\s+(.+)$/);
        if (h) {
            const level = Math.min(h[1].length, 3);
            out.push(`<h${level}>${inline(h[2])}</h${level}>`);
            i++; continue;
        }

        // Blockquote
        if (/^>\s?/.test(line)) {
            const block = [];
            while (i < lines.length && /^>\s?/.test(lines[i])) {
                block.push(lines[i].replace(/^>\s?/, ''));
                i++;
            }
            out.push(`<blockquote>${inline(block.join(' '))}</blockquote>`);
            continue;
        }

        // Unordered list
        if (/^\s*[-*]\s+/.test(line)) {
            out.push('<ul>');
            while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
                out.push(`<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`);
                i++;
            }
            out.push('</ul>');
            continue;
        }

        // Ordered list
        if (/^\s*\d+\.\s+/.test(line)) {
            out.push('<ol>');
            while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
                out.push(`<li>${inline(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`);
                i++;
            }
            out.push('</ol>');
            continue;
        }

        // Blank → paragraph break
        if (line.trim() === '') { i++; continue; }

        // Paragraph: gather contiguous non-blank lines
        const para = [line];
        i++;
        while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,6}\s|\s*[-*]\s|\s*\d+\.\s|>\s?|\u0000CODE\d+\u0000)/.test(lines[i])) {
            para.push(lines[i]);
            i++;
        }
        out.push(`<p>${inline(para.join(' '))}</p>`);
    }
    return out.join('\n');
}

function clearFocus() {
    graphState.focusedNodeIds = null;
    graphState.focusedRoot = null;
    graphState.focusedHops = 0;
    if (graphState.selected) {
        const root = graphState.nodes.find(n => n.id === graphState.selected);
        if (root) showNodeDetail(root);
    }
    kickSimulation();
}

function showNodeDetail(node) {
    const detail = document.getElementById('graph-detail');
    detail.hidden = false;

    // Walk this node's edges, group by predicate, split into outgoing/incoming.
    const out = {}; // predicate -> [{ node, color }]
    const inc = {};
    graphState.edges.forEach(e => {
        if (e.source.id === node.id) {
            (out[e.predicate] = out[e.predicate] || { color: e.color, name: e.predicateName, items: [] }).items.push(e.target);
        }
        if (e.target.id === node.id) {
            (inc[e.predicate] = inc[e.predicate] || { color: e.color, name: e.predicateName, items: [] }).items.push(e.source);
        }
    });

    function renderEdgeGroup(map, heading) {
        const keys = Object.keys(map).sort();
        if (keys.length === 0) return '';
        let h = `<div class="edge-group-heading">${heading}</div>`;
        keys.forEach(p => {
            const g = map[p];
            h += `<div class="edge-group">`;
            h += `<div class="edge-group-pred"><span class="pred-swatch" style="background:${g.color}"></span>${escapeHtml(g.name)}</div>`;
            h += `<ul>`;
            g.items.forEach(target => {
                h += `<li><a href="#" data-id="${escapeHtml(target.id)}">`;
                h += `<span class="node-dot" style="background:${target.color}"></span>`;
                h += `${escapeHtml(target.label)}`;
                h += `</a></li>`;
            });
            h += `</ul></div>`;
        });
        return h;
    }

    const isFocusRoot = graphState.focusedRoot === node.id;
    const focusToolbar = `
        <div class="focus-toolbar">
            ${isFocusRoot
                ? `<span class="focus-status">focused · ${graphState.focusedHops}-hop · ${graphState.focusedNodeIds.size} nodes</span>
                   <button class="focus-btn" data-act="hop+">+1 hop</button>
                   ${graphState.focusedHops > 1 ? `<button class="focus-btn" data-act="hop-">−1 hop</button>` : ''}
                   <button class="focus-btn" data-act="clear">show all</button>`
                : `<button class="focus-btn" data-act="focus1">focus 1-hop</button>
                   <button class="focus-btn" data-act="focus2">focus 2-hop</button>`
            }
        </div>
    `;
    detail.innerHTML = `
        <button class="close">×</button>
        <h3>${escapeHtml(node.label)}</h3>
        <div class="detail-meta">
            <span class="node-dot" style="background:${node.color}"></span>
            ${escapeHtml(node.typeName)} · ${node.degree} connection${node.degree === 1 ? '' : 's'}
        </div>
        ${focusToolbar}
        ${renderEdgeGroup(out, 'Outgoing')}
        ${renderEdgeGroup(inc, 'Incoming')}
        <div class="detail-uri"><code>${escapeHtml(node.id)}</code></div>
    `;
    // Wire the focus toolbar buttons.
    detail.querySelectorAll('.focus-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const act = btn.dataset.act;
            if (act === 'focus1') focusNeighborhood(node.id, 1);
            else if (act === 'focus2') focusNeighborhood(node.id, 2);
            else if (act === 'hop+') focusNeighborhood(node.id, graphState.focusedHops + 1);
            else if (act === 'hop-') focusNeighborhood(node.id, graphState.focusedHops - 1);
            else if (act === 'clear') clearFocus();
        });
    });
    detail.querySelector('.close').addEventListener('click', () => {
        detail.hidden = true;
        graphState.selected = null;
        drawGraph();
    });
    // Click any neighbor link in the detail panel → jump selection to it
    // AND open the markdown viewer pane for that neighbor. (Previously
    // only dblclick opened the viewer, but Rob wanted single-click to be
    // the read-the-thing gesture since the viewer is now pinned bottom-left
    // and doesn't cover the graph.)
    detail.querySelectorAll('a[data-id]').forEach(a => {
        a.addEventListener('click', e => {
            e.preventDefault();
            const id = a.dataset.id;
            const target = graphState.nodes.find(n => n.id === id);
            if (target) {
                graphState.selected = id;
                showNodeDetail(target);
                drawGraph();
                openMarkdownViewer(target);
            }
        });
    });
    // Also let users double-click the title of the currently-selected node
    // to view its own markdown without having to click a neighbor.
    const titleEl = detail.querySelector('h3');
    if (titleEl) {
        titleEl.style.cursor = 'pointer';
        titleEl.title = 'double-click to view markdown';
        titleEl.addEventListener('dblclick', () => openMarkdownViewer(node));
    }
}

// Graph mouse interaction
function initGraphInput() {
    if (!canvas) return;

    canvas.addEventListener('mousedown', e => {
        const rect = canvas.getBoundingClientRect();
        graphState.drag = {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
            startPan: { ...graphState.pan },
        };
    });

    // Shared hit test — the click, double-click and hover paths all ask the
    // same question and were answering it three slightly different times.
    function nodeAt(clientX, clientY) {
        const rect = canvas.getBoundingClientRect();
        const wx = (clientX - rect.left - GW / 2 - graphState.pan.x) / graphState.zoom;
        const wy = (clientY - rect.top - GH / 2 - graphState.pan.y) / graphState.zoom;
        return graphState.nodes.find(n => {
            const dx = n.x - wx, dy = n.y - wy;
            return dx * dx + dy * dy < (n.size + 4) * (n.size + 4);
        });
    }

    canvas.addEventListener('mousemove', e => {
        if (graphState.drag) {
            const rect = canvas.getBoundingClientRect();
            const dx = (e.clientX - rect.left) - graphState.drag.x;
            const dy = (e.clientY - rect.top) - graphState.drag.y;
            graphState.pan.x = graphState.drag.startPan.x + dx;
            graphState.pan.y = graphState.drag.startPan.y + dy;
            drawGraph();
            return;
        }
        // Hover. Nothing here used to answer the mouse at all — the graph sat
        // inert until you committed to a click, which is what made it read as
        // a diagram rather than something you could poke at. Redraw only when
        // the answer actually changes, so this costs nothing while the cursor
        // crosses empty space.
        const hit = nodeAt(e.clientX, e.clientY);
        const id = hit ? hit.id : null;
        if (id !== graphState.hovered) {
            graphState.hovered = id;
            canvas.style.cursor = id ? 'pointer' : 'default';
            drawGraph();
        }
    });

    canvas.addEventListener('mouseleave', () => {
        if (graphState.hovered === null) return;
        graphState.hovered = null;
        canvas.style.cursor = 'default';
        drawGraph();
    });

    window.addEventListener('mouseup', e => {
        if (!graphState.drag) return;
        const moved = Math.abs(e.clientX - (graphState.drag.x + canvas.getBoundingClientRect().left)) > 3;
        graphState.drag = null;
        if (moved) return;
        const hit = nodeAt(e.clientX, e.clientY);
        if (hit) {
            graphState.selected = hit.id;
            showNodeDetail(hit);
            drawGraph();
        }
    });

    canvas.addEventListener('dblclick', e => {
        const hit = nodeAt(e.clientX, e.clientY);
        if (hit) openMarkdownViewer(hit);
    });

    canvas.addEventListener('wheel', e => {
        e.preventDefault();
        // Scale step by the actual wheel delta so trackpad scrolls feel
        // smooth instead of stepped, and halve the overall sensitivity vs
        // the old ±10%-per-tick. Clamp per-event delta so a big spin
        // doesn't blow past the view.
        const SENSITIVITY = 0.0025;
        const delta = Math.max(-40, Math.min(40, e.deltaY));
        const factor = Math.exp(-delta * SENSITIVITY);
        graphState.zoom = Math.max(0.2, Math.min(4, graphState.zoom * factor));
        graphState.userZoomed = true;
        drawGraph();
    }, { passive: false });

    window.addEventListener('resize', () => {
        if (currentMode === 'graph') resizeGraph();
    });
}

// ════════════════════════════════════════════
// HISTORY — animated knowledge graph through time
// ════════════════════════════════════════════

const hist = {
    commits: [],
    idx: -1,
    playing: false,
    timer: null,
    totalAdds: 0,
    totalRemoves: 0,
    nodes: {},
    edges: {},
    canvas: null,
    ctx: null,
    W: 0, H: 0,
    zoom: 1,
    pan: { x: 0, y: 0 },
    drag: null,
    raf: null,
    typeColors: {},
    paletteIdx: 0,
    graphUri: null,
};

const HIST_PALETTE = [
    '#bb2200', '#2266bb', '#6b2aa0', '#d4a800',
    '#2a8a2a', '#cc6600', '#0088aa', '#884466',
    '#446688', '#886644', '#aa4466', '#668844',
];

function histColor(type) {
    if (!type) return '#888';
    const short = type.match(/\/([^/]+)$/)?.[1] || type;
    if (!hist.typeColors[short]) {
        hist.typeColors[short] = HIST_PALETTE[hist.paletteIdx % HIST_PALETTE.length];
        hist.paletteIdx++;
    }
    return hist.typeColors[short];
}

function resizeHistoryCanvas() {
    if (!hist.canvas) return;
    const rect = hist.canvas.getBoundingClientRect();
    hist.W = rect.width;
    hist.H = rect.height;
    hist.canvas.width = hist.W * devicePixelRatio;
    hist.canvas.height = hist.H * devicePixelRatio;
    hist.ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}

// The one graph has the same IRI in every git-lex repo on earth
// (2026_07_21_ONE_GRAPH_AS_SHIPPED.md), so "detection" is just "does it
// hold statement events" — the old per-repo URI probing dance is gone.
async function detectHistoryGraph() {
    const probe = await sparql(`
        PREFIX gl: <https://repolex.ai/ontology/git-lex/>
        SELECT (COUNT(*) AS ?n) WHERE {
            GRAPH <${ONE_GRAPH}> {
                { ?e gl:assertedIn ?c } UNION { ?e gl:retractedIn ?c }
            }
        }
    `);
    if (probe[0] && parseInt(probe[0].n) > 0) return `<${ONE_GRAPH}>`;
    return null;
}

async function initHistory() {
    hist.canvas = document.getElementById('history-canvas');
    if (!hist.canvas) return;
    hist.ctx = hist.canvas.getContext('2d');
    resizeHistoryCanvas();

    // Detect statement history
    hist.graphUri = await detectHistoryGraph();
    if (!hist.graphUri) {
        document.getElementById('hist-msg').textContent =
            'no statement history found — run git lex sync';
        return;
    }

    // Commits that produced statement events, joined to the commits graph
    // for ordinal + date + summary. This is the canonical one-graph ⋈
    // commits join from `git lex log` (cmd_log). g2:ordinalDerived is the
    // ordering authority — author dates can tie or lie under rebase/amend.
    const rows = await sparql(`
        PREFIX gl: <https://repolex.ai/ontology/git-lex/>
        PREFIX g2: <https://repolex.ai/ontology/git-lex/git2/>
        SELECT DISTINCT ?commit ?ord ?when ?msg WHERE {
            GRAPH <${ONE_GRAPH}> {
                { ?e gl:assertedIn ?commit } UNION { ?e gl:retractedIn ?commit }
            }
            GRAPH <${COMMITS_GRAPH}> {
                ?commit g2:ordinalDerived ?ord ; g2:author ?sig .
                ?sig g2:xsdDateTimeDerived ?when .
                OPTIONAL { ?commit g2:summary ?msg }
            }
        } ORDER BY ?ord
    `);

    hist.commits = rows.map(r => ({
        uri: r.commit,
        sha: r.commit.split('/').pop().substring(0, 8),
        date: r.when || '',
        message: (r.msg || '').split('\n')[0].substring(0, 120),
    }));

    document.getElementById('hist-counter').textContent = `0 / ${hist.commits.length}`;
    document.getElementById('hist-msg').textContent =
        `${hist.commits.length} commits loaded — press play`;

    // Wire controls
    document.getElementById('hist-play').addEventListener('click', () => {
        hist.playing ? histStop() : histStart();
    });
    document.getElementById('hist-step').addEventListener('click', () => {
        histStop();
        histStep();
    });
    document.getElementById('hist-reset').addEventListener('click', histReset);

    // Pan/zoom on history canvas
    hist.canvas.addEventListener('mousedown', e => {
        hist.drag = { x: e.clientX, y: e.clientY, px: hist.pan.x, py: hist.pan.y };
    });
    hist.canvas.addEventListener('mousemove', e => {
        if (!hist.drag) return;
        hist.pan.x = hist.drag.px + (e.clientX - hist.drag.x);
        hist.pan.y = hist.drag.py + (e.clientY - hist.drag.y);
    });
    window.addEventListener('mouseup', () => { hist.drag = null; });
    hist.canvas.addEventListener('wheel', e => {
        e.preventDefault();
        const d = Math.max(-40, Math.min(40, e.deltaY));
        hist.zoom *= Math.exp(-d * 0.0025);
        hist.zoom = Math.max(0.1, Math.min(5, hist.zoom));
    }, { passive: false });

    // Start render loop
    function loop() {
        histSimulate();
        histDraw();
        hist.raf = requestAnimationFrame(loop);
    }
    loop();
}

async function histStep() {
    hist.idx++;
    if (hist.idx >= hist.commits.length) { histStop(); return; }

    const commit = hist.commits[hist.idx];
    const events = await sparql(`
        PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
        PREFIX gl: <https://repolex.ai/ontology/git-lex/>
        SELECT ?s ?p ?o ?op WHERE {
            GRAPH ${hist.graphUri} {
                ?e rdf:reifies <<( ?s ?p ?o )>> .
                {
                    ?e gl:assertedIn <${commit.uri}> .
                    BIND("+" AS ?op)
                }
                UNION
                {
                    ?e gl:retractedIn <${commit.uri}> .
                    BIND("-" AS ?op)
                }
            }
        }
    `);

    let adds = 0, removes = 0;

    function ensureNode(uri, size) {
        if (!hist.nodes[uri]) {
            hist.nodes[uri] = {
                id: uri, label: shortName(uri), type: '', color: '#888',
                x: (Math.random() - 0.5) * 400, y: (Math.random() - 0.5) * 400,
                vx: 0, vy: 0, size: size || 6,
                triples: 0, ghost: false,
            };
        }
        return hist.nodes[uri];
    }

    const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    const FM_PREFIX = 'https://repolex.ai/ontology/git-lex/fm/';
    events.forEach(e => {
        // Exact match — substring ".includes('type')" matched git:changeType,
        // git:type, future *.contentType, etc.
        const isType = e.p === RDF_TYPE;
        // Edges connect two extracted docs. SpoEvents only reify sidecar
        // facts (kit props, md links, frontmatter), so no git-machinery
        // filtering is needed anymore — just skip rdf:type and frontmatter
        // literal predicates even when they happen to carry an http-URI value.
        const isEdge = e.o && e.o.startsWith('http') &&
            e.p !== RDF_TYPE &&
            !e.p.startsWith(FM_PREFIX);

        if (e.op === '+') {
            adds++;
            const sNode = ensureNode(e.s, 6);
            sNode.triples++;
            sNode.ghost = false;

            if (isType) {
                sNode.type = e.o;
                sNode.color = histColor(e.o);
            }
            if (isEdge) {
                const oNode = ensureNode(e.o, 5);
                oNode.triples++;
                oNode.ghost = false;
                hist.edges[e.s + '|' + e.o + '|' + e.p] =
                    { source: e.s, target: e.o, predicate: e.p };
            }
        } else {
            removes++;
            // Decrement triple counts on subject
            if (hist.nodes[e.s]) {
                hist.nodes[e.s].triples = Math.max(0, hist.nodes[e.s].triples - 1);
                if (hist.nodes[e.s].triples === 0) hist.nodes[e.s].ghost = true;
            }
            if (isType && hist.nodes[e.s]) {
                hist.nodes[e.s].type = '';
                hist.nodes[e.s].color = '#888';
            }
            if (isEdge) {
                delete hist.edges[e.s + '|' + e.o + '|' + e.p];
                // Decrement on object side too
                if (hist.nodes[e.o]) {
                    hist.nodes[e.o].triples = Math.max(0, hist.nodes[e.o].triples - 1);
                    if (hist.nodes[e.o].triples === 0) hist.nodes[e.o].ghost = true;
                }
            }
        }
    });

    hist.totalAdds += adds;
    hist.totalRemoves += removes;

    // Update node sizes by degree (alive nodes only)
    const deg = {};
    Object.values(hist.edges).forEach(e => {
        deg[e.source] = (deg[e.source] || 0) + 1;
        deg[e.target] = (deg[e.target] || 0) + 1;
    });
    Object.values(hist.nodes).forEach(n => {
        n.size = n.ghost ? 3 : 5 + Math.min(15, (deg[n.id] || 0) * 1.5);
    });

    // Update UI
    document.getElementById('hist-counter').textContent = `${hist.idx + 1} / ${hist.commits.length}`;
    document.getElementById('hist-sha').textContent = commit.sha;
    document.getElementById('hist-msg').textContent = commit.message || '—';
    document.getElementById('hist-date').textContent = commit.date ? commit.date.substring(0, 10) : '';
    const aliveNodes = Object.values(hist.nodes).filter(n => !n.ghost).length;
    document.getElementById('hist-nodes').textContent = aliveNodes;
    document.getElementById('hist-edges').textContent = Object.keys(hist.edges).length;
    document.getElementById('hist-adds').textContent = hist.totalAdds;
    document.getElementById('hist-removes').textContent = hist.totalRemoves;
    document.getElementById('hist-progress').style.width =
        ((hist.idx + 1) / hist.commits.length * 100) + '%';

    updateHistSidebar();
}

function updateHistSidebar() {
    // Count alive nodes per type (ghosts excluded)
    const typeCounts = {};
    let aliveCount = 0, ghostCount = 0;
    Object.values(hist.nodes).forEach(n => {
        if (n.ghost) { ghostCount++; return; }
        aliveCount++;
        const t = n.type || '(untyped)';
        typeCounts[t] = (typeCounts[t] || 0) + 1;
    });

    // Sort by count descending
    const sorted = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);

    // Classes panel
    const classesEl = document.getElementById('graph-classes');
    classesEl.innerHTML = sorted.map(([t, count]) => {
        const short = t === '(untyped)' ? t : (t.match(/\/([^/]+)$/)?.[1] || t);
        const color = t === '(untyped)' ? '#888' : histColor(t);
        return `<div class="graph-class-row">
            <span class="graph-class-dot" style="background:${color}"></span>
            <span class="graph-class-name">${short}</span>
            <span class="graph-class-count">${count}</span>
        </div>`;
    }).join('');

    // Stats panel
    const metaEl = document.getElementById('graph-meta');
    metaEl.innerHTML = `
        <div>${aliveCount} alive${ghostCount ? ` · ${ghostCount} ghost` : ''}</div>
        <div>${Object.keys(hist.edges).length} edges</div>
        <div>${sorted.length} types</div>
        <div>${hist.commits.length} commits</div>
    `;

    // Predicates panel — count edges by predicate
    const predCounts = {};
    Object.values(hist.edges).forEach(e => {
        const short = e.predicate.match(/\/([^/]+)$/)?.[1] || e.predicate;
        predCounts[short] = (predCounts[short] || 0) + 1;
    });
    const predSorted = Object.entries(predCounts).sort((a, b) => b[1] - a[1]);
    const predsEl = document.getElementById('graph-predicates');
    predsEl.innerHTML = predSorted.map(([p, count]) =>
        `<div class="graph-class-row">
            <span class="graph-class-name">${p}</span>
            <span class="graph-class-count">${count}</span>
        </div>`
    ).join('');
}

function histSimulate() {
    const alive = Object.values(hist.nodes).filter(n => !n.ghost);
    const edgeArr = Object.values(hist.edges);
    const N = alive.length;
    if (N === 0) return;

    const repulsion = Math.max(30, 500 / Math.sqrt(N));

    for (let i = 0; i < N; i++) {
        const a = alive[i];
        for (let j = i + 1; j < N; j++) {
            const b = alive[j];
            let dx = b.x - a.x, dy = b.y - a.y;
            let d2 = dx * dx + dy * dy;
            if (d2 < 1) d2 = 1;
            const f = repulsion / d2;
            a.vx -= dx * f; a.vy -= dy * f;
            b.vx += dx * f; b.vy += dy * f;
        }
    }

    edgeArr.forEach(e => {
        const a = hist.nodes[e.source], b = hist.nodes[e.target];
        if (!a || !b || a.ghost || b.ghost) return;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = (d - 50) * 0.02;
        a.vx += (dx / d) * f; a.vy += (dy / d) * f;
        b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
    });

    alive.forEach(n => {
        n.vx -= n.x * 0.008;
        n.vy -= n.y * 0.008;
        n.vx *= 0.82;
        n.vy *= 0.82;
        n.x += n.vx;
        n.y += n.vy;
    });

    // Ghosts: freeze velocity, slowly drift toward center
    Object.values(hist.nodes).forEach(n => {
        if (!n.ghost) return;
        n.vx = 0; n.vy = 0;
    });
}

function histDraw() {
    if (!hist.ctx) return;
    const c = hist.ctx;
    c.clearRect(0, 0, hist.W, hist.H);
    c.save();
    c.translate(hist.W / 2 + hist.pan.x, hist.H / 2 + hist.pan.y);
    c.scale(hist.zoom, hist.zoom);

    // Edges (alive only)
    c.lineWidth = 0.8 / hist.zoom;
    Object.values(hist.edges).forEach(e => {
        const a = hist.nodes[e.source], b = hist.nodes[e.target];
        if (!a || !b) return;
        c.strokeStyle = 'rgba(0,0,0,0.12)';
        c.beginPath();
        c.moveTo(a.x, a.y);
        c.lineTo(b.x, b.y);
        c.stroke();
    });

    // Ghost nodes — faint, behind alive nodes
    c.globalAlpha = 0.08;
    Object.values(hist.nodes).forEach(n => {
        if (!n.ghost) return;
        c.fillStyle = '#888';
        c.beginPath();
        c.arc(n.x, n.y, n.size / hist.zoom, 0, Math.PI * 2);
        c.fill();
    });
    c.globalAlpha = 1;

    // Alive nodes
    Object.values(hist.nodes).forEach(n => {
        if (n.ghost) return;
        c.fillStyle = n.color;
        c.beginPath();
        c.arc(n.x, n.y, n.size / hist.zoom, 0, Math.PI * 2);
        c.fill();
    });

    // Labels (alive only)
    if (hist.zoom > 0.5) {
        c.font = `${11 / hist.zoom}px 'American Typewriter', Courier, monospace`;
        c.fillStyle = '#222';
        c.textAlign = 'center';
        c.textBaseline = 'top';
        Object.values(hist.nodes).forEach(n => {
            if (n.ghost) return;
            if (n.size < 5 && hist.zoom < 1) return;
            c.fillText(n.label, n.x, n.y + n.size / hist.zoom + 3 / hist.zoom);
        });
    }

    c.restore();
}

function histStart() {
    if (hist.playing) return;
    hist.playing = true;
    document.getElementById('hist-play').textContent = 'pause';
    document.getElementById('hist-play').classList.add('active');
    (function next() {
        if (!hist.playing) return;
        hist.timer = setTimeout(async () => {
            await histStep();
            if (hist.idx < hist.commits.length - 1) next();
            else histStop();
        }, parseInt(document.getElementById('hist-speed').value) || 800);
    })();
}

function histStop() {
    hist.playing = false;
    clearTimeout(hist.timer);
    document.getElementById('hist-play').textContent = 'play';
    document.getElementById('hist-play').classList.remove('active');
}

function histReset() {
    histStop();
    hist.idx = -1;
    hist.totalAdds = 0;
    hist.totalRemoves = 0;
    hist.paletteIdx = 0;
    for (const k in hist.nodes) delete hist.nodes[k];
    for (const k in hist.edges) delete hist.edges[k];
    for (const k in hist.typeColors) delete hist.typeColors[k];
    document.getElementById('hist-counter').textContent = `0 / ${hist.commits.length}`;
    document.getElementById('hist-sha').textContent = '—';
    document.getElementById('hist-msg').textContent = 'press play to begin';
    document.getElementById('hist-date').textContent = '';
    document.getElementById('hist-nodes').textContent = '0';
    document.getElementById('hist-edges').textContent = '0';
    document.getElementById('hist-adds').textContent = '0';
    document.getElementById('hist-removes').textContent = '0';
    document.getElementById('hist-progress').style.width = '0%';
    document.getElementById('graph-classes').innerHTML = '';
    document.getElementById('graph-predicates').innerHTML = '';
    document.getElementById('graph-meta').innerHTML = '';
}

// ════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
    initRouting();
    initGraphInput();
    updateSnapshotPill();
    initSyncButton();
    // Resize graph on window changes
    window.addEventListener('resize', () => {
        if (currentMode === 'graph') resizeGraph();
        if (currentMode === 'history') resizeHistoryCanvas();
    });
});

// Sync button — triggers git lex sync via POST /api/sync.
// Degrades gracefully if the endpoint doesn't exist (404 → no-op).
function initSyncButton() {
    const btn = document.getElementById('sync-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
        if (btn.classList.contains('syncing')) return;
        btn.classList.add('syncing');
        btn.textContent = 'syncing…';
        try {
            const r = await fetch('/api/sync', { method: 'POST' });
            if (r.ok) {
                btn.textContent = 'synced ✓';
                // Reload the current view to pick up new data.
                setTimeout(() => {
                    btn.textContent = 'sync';
                    btn.classList.remove('syncing');
                    if (currentMode === 'activity') loadActivity();
                    else if (currentMode === 'graph') loadGraph();
                }, 1200);
            } else {
                btn.textContent = 'sync';
                btn.classList.remove('syncing');
            }
        } catch (e) {
            btn.textContent = 'sync';
            btn.classList.remove('syncing');
        }
    });
}

// Store-inventory pill — speaks the shipped /api/store-info contract
// (git-lex-serve 72e9766, one-graph model): { graphs, one_graph, now_view,
// model }. `graphs` is per-graph quad counts in the flat rows format
// ({results: [{g, n}]}). Shows graph + quad totals in the pill; the full
// per-graph inventory and model identifier live in the tooltip. If the
// endpoint 404s (pre-one-graph server) the pill hides itself.
//
// Pill sketch originally contributed by @M3RCUR14L (2026-04-09) as a
// staleness indicator; rebuilt for the one-graph inventory contract.
async function updateSnapshotPill() {
    const el = document.getElementById('store-snapshot');
    const ageEl = document.getElementById('store-snapshot-age');
    if (!el || !ageEl) return;
    try {
        const r = await fetch('/api/store-info');
        if (!r.ok) return;  // leaves pill hidden — graceful degrade
        const info = await r.json();
        const rows = (info && info.graphs && info.graphs.results) || [];
        if (!rows.length) return;
        const counts = rows.map(row => ({
            g: row.g || '',
            n: parseInt(row.n) || 0,
        }));
        const total = counts.reduce((sum, row) => sum + row.n, 0);
        el.hidden = false;
        ageEl.textContent =
            `${counts.length} graph${counts.length === 1 ? '' : 's'} · ` +
            `${total.toLocaleString()} quads`;
        el.title = (info.model ? info.model + '\n\n' : '') +
            counts.map(row => `${row.n.toLocaleString()}  ${row.g}`).join('\n');
    } catch (e) {
        // Network error or malformed response — leave pill hidden.
    }
}



// ════════════════════════════════════════════
// WHOLE SOUL
// ════════════════════════════════════════════
//
// The view that must not break. The force graph is a good instrument up to a
// couple of thousand documents and then it stops being one: measured on
// @selkie's soul (6,359 nodes), a live simulation costs 37ms a frame, at
// 100,000 it costs 1.06 SECONDS, and before the scale fix it diverged to
// coordinates of 1e50 and drew a blank canvas under a confident node count.
//
// So this view gives up the two things that cost the most and buys back the
// one thing that matters: it never simulates, and it never labels.
//
//   position  = WHEN the document first appeared, as a spiral. Centre is the
//               first commit, rim is now, one turn is one slice of the repo's
//               life. Bursts read as dense arcs, quiet months as gaps, and a
//               link between distant eras visibly crosses the years.
//   colour    = class.
//   size      = how many times the document has changed.
//
// Deterministic and O(n): nothing depends on the previous frame, so there is
// nothing to diverge and nothing to settle. It draws the same picture every
// time you open it, which is what makes it something two people can talk about.

// Turns are chosen from the size of the soul, not fixed. Seven turns of a
// 6,000-document soul is a legible year-by-year spiral; seven turns of a
// 130-document one is confetti — too few dots per turn for the arc to read as
// an arc at all. Roughly 900 documents per turn keeps the arcs dense enough to
// see, and a young soul just gets a ring.
function soulTurnsFor(n) {
    return Math.max(2, Math.min(7, Math.ceil(n / 900)));
}
const SOUL_POINT_BASE = 3.2;

const soul = {
    canvas: null, gl: null, ctx2d: null,
    W: 0, H: 0, dpr: 1,
    nodes: [], lines: null,
    classes: [],
    view: { scale: 1, x: 0, y: 0 },
    gpu: null,
    grid: null, cell: 0.05,
    drag: null,
    ready: false,
};

async function initSoulView() {
    soul.canvas = document.getElementById('soul-canvas');
    const hud = document.getElementById('soul-hud');
    hud.innerHTML = '<div class="soul-title">the whole soul</div><div class="soul-sub">reading the store…</div>';
    resizeSoulCanvas();

    // Four reads, in parallel. nodes/edges are the same render-ready routes the
    // repo graph uses; the alias join folds each document's Thing onto its File
    // (see loadGraph — same reasoning, same map); births come from the event
    // log, which is the only place that knows when a document first existed.
    const [nodeRows, edgeRows, aliasRows, bornRows] = await Promise.all([
        fetch(API + '/api/viz/nodes').then(r => r.json()).then(d => d.results || []).catch(() => []),
        fetchDocEdges(),
        sparql(`
            PREFIX gl: <https://repolex.ai/ontology/git-lex/>
            SELECT ?thing ?file WHERE { GRAPH <${NOW_GRAPH}> { ?thing gl:fileId ?file } }
        `).catch(() => []),
        // MIN(ordinal) over every fact ever asserted about a subject = the
        // commit the document was born in. ordinalDerived is the ordering
        // authority; author dates tie and lie under rebase.
        sparql(`
            PREFIX gl: <https://repolex.ai/ontology/git-lex/>
            PREFIX g2: <https://repolex.ai/ontology/git-lex/git2/>
            PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
            SELECT ?s (MIN(?ord) AS ?born) (COUNT(?e) AS ?events) WHERE {
                GRAPH <${ONE_GRAPH}> { ?e rdf:reifies <<( ?s ?p ?o )>> ; gl:assertedIn ?c }
                GRAPH <${COMMITS_GRAPH}> { ?c g2:ordinalDerived ?ord }
            } GROUP BY ?s
        `).catch(() => []),
    ]);

    if (!nodeRows.length) {
        hud.innerHTML = '<div class="soul-title">the whole soul</div>' +
            '<div class="soul-sub">no documents in the store — run <code>git lex sync</code></div>';
        return;
    }

    soulBuild(nodeRows, edgeRows, aliasRows, bornRows);
    soulInitRenderer();
    soulBindInput();
    soul.ready = true;
    soulDraw();
}

// Fold twins, lay out, colour, and pack straight into typed arrays. One pass,
// no intermediate object graph to walk per frame.
function soulBuild(nodeRows, edgeRows, aliasRows, bornRows) {
    const fileOfThing = new Map();
    aliasRows.forEach(r => { if (r.thing && r.file) fileOfThing.set(r.thing, r.file); });

    const bornOf = new Map(), eventsOf = new Map();
    bornRows.forEach(r => {
        bornOf.set(r.s, +r.born);
        eventsOf.set(r.s, +r.events);
    });

    // Group rows by folded subject, keeping the most specific type.
    const bySubject = new Map();
    nodeRows.forEach(r => {
        if (isHiddenType(r.type)) return;
        const id = fileOfThing.get(r.id) || r.id;
        let e = bySubject.get(id);
        if (!e) { e = { id, types: [], labels: {}, twins: new Set([r.id]) }; bySubject.set(id, e); }
        e.types.push(r.type);
        e.labels[r.type] = r.label;
        e.twins.add(r.id);
    });

    const docs = [];
    for (const e of bySubject.values()) {
        const type = pickCanonicalType(e.types);
        if (!type) continue;
        docs.push({ id: e.id, type, label: e.labels[type] || shortName(e.id), twins: [...e.twins] });
    }

    // Class palette ordered by size, so the biggest class is stable across
    // reloads and the legend reads as a census.
    const counts = new Map();
    docs.forEach(d => counts.set(d.type, (counts.get(d.type) || 0) + 1));
    // Colour order is meaning order, not arrival or size order. git-lex:File is
    // the TRANSITORY plane — substrate, not identity — and on a soul with many
    // unclassed documents it is also the biggest class, so sorting by size hands
    // the loudest colour to the least meaningful thing on screen. It goes last
    // and it goes grey. (My own standing complaint about this palette, finally
    // applied to my own view; caught by my other seat reading the render.)
    const GENERIC_FILE = 'https://repolex.ai/ontology/git-lex/File';
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const meaningful = ranked.filter(([uri]) => uri !== GENERIC_FILE);
    const generic = ranked.filter(([uri]) => uri === GENERIC_FILE);
    soul.classes = meaningful
        .map(([uri, count], i) => ({ uri, count, name: shortName(uri), color: colorForClass(i) }))
        .concat(generic.map(([uri, count]) => ({ uri, count, name: shortName(uri), color: '#b9b9bd' })));
    const colorOf = new Map(soul.classes.map(c => [c.uri, c.color]));

    // Birth ordinal: a document is as old as the earliest fact about EITHER of
    // its subjects. A Thing minted later than its File is still the same
    // document arriving.
    const bornFor = d => {
        let best = null;
        for (const t of d.twins) {
            const b = bornOf.get(t);
            if (b != null && (best == null || b < best)) best = b;
        }
        return best;
    };
    const eventsFor = d => d.twins.reduce((n, t) => n + (eventsOf.get(t) || 0), 0);

    let minB = Infinity, maxB = -Infinity;
    docs.forEach(d => {
        const b = bornFor(d);
        d.born = b;
        if (b != null) { if (b < minB) minB = b; if (b > maxB) maxB = b; }
    });
    if (!isFinite(minB)) { minB = 0; maxB = 1; }
    const span = Math.max(1, maxB - minB);

    // Deterministic hash — same document, same speck, every session.
    const hash = str => {
        let h = 2166136261;
        for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
        return (h >>> 0) / 4294967295;
    };

    const n = docs.length;
    soul.turns = soulTurnsFor(n);
    const pos = new Float32Array(n * 2);
    const col = new Float32Array(n * 3);
    const siz = new Float32Array(n);
    const posOf = new Map();
    let undated = 0;

    // Documents born in the SAME commit share a t exactly, so without this they
    // stack on one speck and a 40-document commit reads as a single dot. Spread
    // each birth-group along the arc that commit actually owns: the time stays
    // honest (they really were born together), the pile becomes a stroke, and a
    // busy commit becomes visibly busy instead of invisibly big.
    const groups = new Map();
    docs.forEach(d => {
        const k = d.born == null ? 'undated' : d.born;
        const g = groups.get(k);
        if (g) g.push(d); else groups.set(k, [d]);
    });
    groups.forEach(g => g.forEach((d, i) => { d.groupIdx = i; d.groupSize = g.length; }));
    const arcPerCommit = (2 * Math.PI * soul.turns) / Math.max(1, span);

    docs.forEach((d, i) => {
        let t;
        if (d.born == null) { t = 1; undated++; } else { t = (d.born - minB) / span; }
        const j = hash(d.id);
        // Fan within the commit, widening a little for very large groups so a
        // 500-document import doesn't overlap itself into a solid bar.
        const fanWidth = arcPerCommit * Math.min(6, Math.max(1, Math.log2(d.groupSize + 1)));
        const fan = d.groupSize > 1
            ? ((d.groupIdx + 0.5) / d.groupSize - 0.5) * fanWidth
            : 0;
        const theta = 2 * Math.PI * soul.turns * t + fan + (j - 0.5) * 0.05;
        // Radius also fans slightly, so a dense commit reads as a short comb
        // rather than a hairline.
        const rFan = d.groupSize > 1 ? ((hash(d.id + 'g') - 0.5) * 0.02) : 0;
        const r = 0.12 + 0.86 * t + (hash(d.id + 'r') - 0.5) * 0.02 + rFan;
        const x = Math.cos(theta) * r;
        const y = Math.sin(theta) * r;
        pos[i * 2] = x; pos[i * 2 + 1] = y;
        posOf.set(d.id, i);
        d.x = x; d.y = y;
        const c = colorOf.get(d.type) || '#888888';
        col[i * 3]     = parseInt(c.slice(1, 3), 16) / 255;
        col[i * 3 + 1] = parseInt(c.slice(3, 5), 16) / 255;
        col[i * 3 + 2] = parseInt(c.slice(5, 7), 16) / 255;
        d.events = eventsFor(d);
        siz[i] = Math.min(9, SOUL_POINT_BASE + Math.log2(d.events + 1) * 0.85);
    });

    // Edges become chords. Endpoints go through the SAME fold as the nodes —
    // skipping that is how the repo graph silently dropped every Thing-plane
    // link for a day.
    //
    // Kept per predicate, because on a real corpus one relation can outnumber
    // every other by an order of magnitude — 5,071 lookBeingId against 11
    // Beings — and drawing that unannounced turns the picture into a fan. All
    // of them are here and counted; the ones that would swamp the view start
    // switched off, and the legend says so instead of the code deciding
    // quietly.
    soul.edgesByPred = new Map();
    let dropped = 0;
    // Keep examples, not just a tally. A count of damage with no way to reach
    // the thing it counts tells you damage exists and hides where — which is
    // the failure the dead-end rendering was built to end. (@w3bl0rd, wC seat.)
    soul.droppedExamples = [];
    edgeRows.forEach(e => {
        const a = posOf.get(fileOfThing.get(e.from) || e.from);
        const b = posOf.get(fileOfThing.get(e.target) || e.target);
        if (a == null || b == null || a === b) {
            dropped++;
            if (soul.droppedExamples.length < 40 && a !== b) {
                soul.droppedExamples.push(
                    shortName(e.from) + ' —' + shortName(e.predicate) + '→ ' +
                    (b == null ? shortName(e.target) : '(self)'));
            }
            return;
        }
        const bucket = soul.edgesByPred.get(e.predicate);
        if (bucket) bucket.push(a, b); else soul.edgesByPred.set(e.predicate, [a, b]);
    });

    soul.nodes = docs;
    soul.pos = pos; soul.col = col; soul.siz = siz;

    // A relation whose edge count dwarfs the number of things it points AT is a
    // fan, not a web: it says one true thing once and then says it five
    // thousand more times over the top of everything else.
    const FAN_RATIO = 8;
    soul.predicates = [...soul.edgesByPred.entries()]
        .map(([uri, arr], i) => {
            const count = arr.length / 2;
            const targets = new Set();
            for (let k = 1; k < arr.length; k += 2) targets.add(arr[k]);
            return { uri, name: shortName(uri), count,
                     fan: count / Math.max(1, targets.size),
                     enabled: (count / Math.max(1, targets.size)) < FAN_RATIO,
                     color: colorForEdge(i) };
        })
        .sort((a, b) => b.count - a.count);

    // A single commit that accounts for a large slice of all births is an
    // IMPORT, not a week of work — 51 of my own documents share one commit,
    // because that is when a pile of memories entered the repo, not when they
    // were thought. The arc it draws looks like a burst of authorship and is
    // not one. Name it rather than letting the shape imply it.
    const birthCounts = new Map();
    docs.forEach(d => { if (d.born != null) birthCounts.set(d.born, (birthCounts.get(d.born) || 0) + 1); });
    let biggestBirth = null;
    birthCounts.forEach((count, ord) => {
        if (!biggestBirth || count > biggestBirth.count) biggestBirth = { ord, count };
    });
    const importish = biggestBirth && biggestBirth.count >= Math.max(10, n * 0.08)
        ? biggestBirth : null;

    soul.stats = { docs: n, droppedEdges: dropped, undated,
                   commits: (maxB - minB + 1), minB, maxB, importish,
                   distinctBirths: birthCounts.size,
                   totalEdges: soul.predicates.reduce((t, p) => t + p.count, 0) };
    soulRebuildLines();

    // The spiral track itself, drawn as a hairline under the dots. Without it
    // "position is time" is a claim in the caption that the picture does not
    // make: at two turns an Archimedean spiral is indistinguishable from a blob,
    // and there is no way to see where the centre is or which way is outward.
    // Labels belong on the AXIS, not on 6,000 documents.
    const guide = [];
    const STEPS = 900;
    let px = null, py = null;
    for (let i = 0; i <= STEPS; i++) {
        const t = i / STEPS;
        const th = 2 * Math.PI * soul.turns * t;
        const rr = 0.12 + 0.86 * t;
        const gx = Math.cos(th) * rr, gy = Math.sin(th) * rr;
        if (px !== null) guide.push(px, py, gx, gy);
        px = gx; py = gy;
    }
    // A tick where each turn closes, so the eye can count them.
    for (let k = 1; k <= soul.turns; k++) {
        const t = k / soul.turns;
        const th = 2 * Math.PI * soul.turns * t;
        const rr = 0.12 + 0.86 * t;
        const ux = Math.cos(th), uy = Math.sin(th);
        guide.push(ux * (rr - 0.035), uy * (rr - 0.035), ux * (rr + 0.035), uy * (rr + 0.035));
    }
    // Centre mark — the first commit, which is otherwise the emptiest part of
    // the picture and reads as an absence rather than a beginning.
    guide.push(-0.02, 0, 0.02, 0, 0, -0.02, 0, 0.02);
    soul.guide = new Float32Array(guide);

    // Uniform grid for hover picking. Positions never move, so this is built
    // once and answers every mousemove in constant time.
    soul.grid = new Map();
    docs.forEach((d, i) => {
        const k = Math.floor(d.x / soul.cell) + ',' + Math.floor(d.y / soul.cell);
        const b = soul.grid.get(k);
        if (b) b.push(i); else soul.grid.set(k, [i]);
    });

    soulRenderHud();
}

// Pack the enabled predicates into one line buffer. Positions never move, so
// this runs on load and on a predicate toggle, never per frame.
function soulRebuildLines() {
    let total = 0;
    soul.predicates.forEach(p => { if (p.enabled) total += soul.edgesByPred.get(p.uri).length / 2; });
    const xy = new Float32Array(total * 4);
    let w = 0;
    soul.predicates.forEach(p => {
        if (!p.enabled) return;
        const arr = soul.edgesByPred.get(p.uri);
        for (let i = 0; i < arr.length; i += 2) {
            const a = arr[i], b = arr[i + 1];
            xy[w++] = soul.pos[a * 2]; xy[w++] = soul.pos[a * 2 + 1];
            xy[w++] = soul.pos[b * 2]; xy[w++] = soul.pos[b * 2 + 1];
        }
    });
    soul.lines = xy;
    soul.edgeCount = total;
    if (soul.gpu) {
        const gl = soul.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, soul.gpu.bLine);
        gl.bufferData(gl.ARRAY_BUFFER, soul.lines, gl.STATIC_DRAW);
    }
}

function soulRenderHud() {
    const s = soul.stats;
    const hud = document.getElementById('soul-hud');
    const undatedNote = s.undated
        ? ` · <span title="no assertion event found for these — they sit on the rim">${s.undated.toLocaleString()} undated</span>`
        : '';
    hud.innerHTML =
        '<div class="soul-title">the whole soul</div>' +
        `<div>${s.docs.toLocaleString()} documents · ${soul.edgeCount.toLocaleString()} of ` +
        `${s.totalEdges.toLocaleString()} links drawn · ${s.commits.toLocaleString()} commits${undatedNote}` +
        // Statements that point somewhere this view cannot draw — at a Moment,
        // an image, anything that is not a document. They are real facts and
        // they are not on the canvas, so the canvas says how many.
        (s.droppedEdges
            ? ` · <span class="soul-dropped" title="Statements whose target is not a document — Moments, images, ids that resolve to nothing.&#10;&#10;` +
              `${(soul.droppedExamples || []).slice(0, 25).join('&#10;')}` +
              `${s.droppedEdges > 25 ? '&#10;… and ' + (s.droppedEdges - 25).toLocaleString() + ' more' : ''}">` +
              `${s.droppedEdges.toLocaleString()} point outside the document graph</span>`
            : '') +
        '</div>' +
        // The legend showed the top eight and said nothing about the rest, so on
        // an 18-class soul it quietly implied there were eight. A legend that
        // disagrees with the picture is the same defect as a picture that
        // disagrees with the data — and it is invisible from inside either
        // half. (@w3bl0rd's other seat, via nug3's audit of the subtexture
        // page, where a card said "specified" and the prose two sections down
        // told you to go run it.)
        '<div class="soul-sub">' + soul.classes.slice(0, 8).map(c =>
            `<span style="color:${c.color}">■</span> ${c.name} ${c.count.toLocaleString()}`).join(' &nbsp; ') +
        (soul.classes.length > 8
            ? ` &nbsp; <span title="${soul.classes.slice(8).map(c => c.name + ' ' + c.count).join(', ')}">` +
              `+${soul.classes.length - 8} more classes, ` +
              `${soul.classes.slice(8).reduce((t, c) => t + c.count, 0).toLocaleString()} documents</span>`
            : '') +
        '</div>' +
        '<div class="soul-preds">' + soul.predicates.map((p, i) =>
            `<label class="soul-pred${p.enabled ? '' : ' off'}" title="${p.uri}${p.fan >= 8 ? ' — off by default: ' + p.count.toLocaleString() + ' edges into ' + Math.round(p.count / p.fan).toLocaleString() + ' targets' : ''}">` +
            `<input type="checkbox" data-pred="${i}"${p.enabled ? ' checked' : ''}> ` +
            `${p.name} <span class="soul-pred-n">${p.count.toLocaleString()}</span></label>`).join('') +
        '</div>';
    hud.querySelectorAll('input[data-pred]').forEach(box => {
        box.addEventListener('change', () => {
            soul.predicates[+box.dataset.pred].enabled = box.checked;
            soulRebuildLines();
            soulRenderHud();
            soulDraw();
        });
    });
    // The caveat travels with the picture. Position is the commit that first
    // asserted the document, which equals when it was WRITTEN only if saving
    // follows writing closely. @selkie measured it on 60 look-notes across her
    // whole corpus: median lag from the moment described to the commit is 2.9
    // minutes and 50 of 60 land within a day — but the tail is long, the 90th
    // percentile is 37 days, and the worst was 65. So roughly one dot in six
    // sits in the wrong turn entirely. Small enough not to bend the shape,
    // large enough that no single dot's position is a fact.
    const importNote = s.importish
        ? ` · <span title="one commit, ${s.importish.count} documents — an import or a migration, not a week of work">` +
          `${s.importish.count.toLocaleString()} share one birth commit</span>`
        : '';
    document.getElementById('soul-axis').innerHTML =
        'centre = first commit · rim = today · one turn ≈ ' +
        Math.round(s.commits / soul.turns).toLocaleString() +
        ' commits · dot size = how often it changed' + importNote +
        ' · scroll to zoom, drag to pan' +
        '<br><span title="Measured on @selkie&#39;s corpus: median 2.9 minutes from the moment described to the commit, but a long tail — 90th percentile 37 days. The shape is reliable; a single dot is not.">' +
        'position is when it was SAVED, which is when it was written only if you save as you go' +
        '</span>';
}

function resizeSoulCanvas() {
    if (!soul.canvas) return;
    const rect = soul.canvas.getBoundingClientRect();
    soul.dpr = window.devicePixelRatio || 1;
    soul.W = rect.width; soul.H = rect.height;
    soul.canvas.width = Math.max(1, Math.round(rect.width * soul.dpr));
    soul.canvas.height = Math.max(1, Math.round(rect.height * soul.dpr));
    if (soul.ready) soulDraw();
}

// ── renderer ────────────────────────────────────────────────────────────────
// WebGL when it is there (1M points at 21ms, measured), 2D canvas when it is
// not. The fallback is not decoration: a machine without WebGL2 should get a
// slower picture, never a blank one.

function soulInitRenderer() {
    const gl = soul.canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) { soul.gl = null; soul.ctx2d = soul.canvas.getContext('2d'); return; }
    soul.gl = gl;

    const compile = (type, src) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src); gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
        return sh;
    };
    const link = (vs, fs) => {
        const p = gl.createProgram();
        gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
        gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
        return p;
    };

    const VIEW = 'uniform vec2 u_scale; uniform vec2 u_off;';
    const pLine = link(
        `#version 300 es
         ${VIEW}
         in vec2 p;
         void main(){ gl_Position = vec4((p + u_off) * u_scale, 0.0, 1.0); }`,
        `#version 300 es
         precision mediump float; uniform vec4 u_col; out vec4 o;
         void main(){ o = u_col; }`);
    const pPoint = link(
        `#version 300 es
         ${VIEW}
         uniform float u_pt;
         in vec2 p; in vec3 c; in float s; out vec3 vc;
         void main(){ vc = c; gl_PointSize = s * u_pt;
                      gl_Position = vec4((p + u_off) * u_scale, 0.0, 1.0); }`,
        `#version 300 es
         precision mediump float; in vec3 vc; out vec4 o;
         void main(){ vec2 d = gl_PointCoord - 0.5; float r = dot(d, d);
                      if (r > 0.25) discard;
                      o = vec4(vc, 1.0 - smoothstep(0.15, 0.25, r)); }`);

    const buf = data => {
        const b = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, b);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        return b;
    };
    soul.gpu = {
        pLine, pPoint,
        bLine: buf(soul.lines), bGuide: buf(soul.guide),
        bPos: buf(soul.pos), bCol: buf(soul.col), bSiz: buf(soul.siz),
    };
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
}

function soulDraw() {
    if (!soul.ready) return;
    const { scale, x, y } = soul.view;
    // World is a unit disc; fit it to the short axis and leave a margin.
    const aspect = soul.W / Math.max(1, soul.H);
    const sx = (0.92 * scale) / (aspect > 1 ? aspect : 1);
    const sy = (0.92 * scale) * (aspect < 1 ? aspect : 1);

    if (soul.gl) {
        const gl = soul.gl, g = soul.gpu;
        gl.viewport(0, 0, soul.canvas.width, soul.canvas.height);
        gl.clearColor(1, 1, 1, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.useProgram(g.pLine);
        gl.uniform2f(gl.getUniformLocation(g.pLine, 'u_scale'), sx, sy);
        gl.uniform2f(gl.getUniformLocation(g.pLine, 'u_off'), x, y);
        const locLine = gl.getAttribLocation(g.pLine, 'p');
        const colLoc = gl.getUniformLocation(g.pLine, 'u_col');

        // Track first, under everything.
        gl.uniform4f(colLoc, 0.55, 0.55, 0.58, 0.55);
        gl.bindBuffer(gl.ARRAY_BUFFER, g.bGuide);
        gl.enableVertexAttribArray(locLine); gl.vertexAttribPointer(locLine, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.LINES, 0, soul.guide.length / 2);

        // Chords, quieter than they were. A chord's PATH across the interior is
        // an artifact of the layout — only its endpoints mean anything — so it
        // must not out-shout dots that carry three real dimensions each.
        gl.uniform4f(colLoc, 0.10, 0.10, 0.12, 0.07);
        gl.bindBuffer(gl.ARRAY_BUFFER, g.bLine);
        gl.enableVertexAttribArray(locLine); gl.vertexAttribPointer(locLine, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.LINES, 0, soul.edgeCount * 2);

        gl.useProgram(g.pPoint);
        gl.uniform2f(gl.getUniformLocation(g.pPoint, 'u_scale'), sx, sy);
        gl.uniform2f(gl.getUniformLocation(g.pPoint, 'u_off'), x, y);
        gl.uniform1f(gl.getUniformLocation(g.pPoint, 'u_pt'),
                     soul.dpr * Math.min(3.5, Math.max(0.6, Math.sqrt(scale))));
        let loc = gl.getAttribLocation(g.pPoint, 'p');
        gl.bindBuffer(gl.ARRAY_BUFFER, g.bPos);
        gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        let lc = gl.getAttribLocation(g.pPoint, 'c');
        gl.bindBuffer(gl.ARRAY_BUFFER, g.bCol);
        gl.enableVertexAttribArray(lc); gl.vertexAttribPointer(lc, 3, gl.FLOAT, false, 0, 0);
        let ls = gl.getAttribLocation(g.pPoint, 's');
        gl.bindBuffer(gl.ARRAY_BUFFER, g.bSiz);
        gl.enableVertexAttribArray(ls); gl.vertexAttribPointer(ls, 1, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.POINTS, 0, soul.nodes.length);
        return;
    }

    // 2D fallback
    const c = soul.ctx2d;
    c.setTransform(soul.dpr, 0, 0, soul.dpr, 0, 0);
    c.clearRect(0, 0, soul.W, soul.H);
    const toX = wx => (wx + x) * sx * soul.W / 2 + soul.W / 2;
    const toY = wy => -(wy + y) * sy * soul.H / 2 + soul.H / 2;
    c.strokeStyle = 'rgba(140,140,150,0.55)'; c.lineWidth = 1; c.beginPath();
    for (let i = 0; i < soul.guide.length; i += 4) {
        c.moveTo(toX(soul.guide[i]), toY(soul.guide[i+1]));
        c.lineTo(toX(soul.guide[i+2]), toY(soul.guide[i+3]));
    }
    c.stroke();
    c.strokeStyle = 'rgba(20,20,28,0.10)'; c.lineWidth = 1; c.beginPath();
    for (let i = 0; i < soul.edgeCount; i++) {
        c.moveTo(toX(soul.lines[i*4]), toY(soul.lines[i*4+1]));
        c.lineTo(toX(soul.lines[i*4+2]), toY(soul.lines[i*4+3]));
    }
    c.stroke();
    soul.nodes.forEach((d, i) => {
        c.fillStyle = (soul.classes.find(k => k.uri === d.type) || {}).color || '#888';
        c.beginPath();
        c.arc(toX(d.x), toY(d.y), Math.max(1, soul.siz[i] / 2), 0, Math.PI * 2);
        c.fill();
    });
}

// ── input ───────────────────────────────────────────────────────────────────

function soulScreenToWorld(clientX, clientY) {
    const rect = soul.canvas.getBoundingClientRect();
    const aspect = soul.W / Math.max(1, soul.H);
    const sx = (0.92 * soul.view.scale) / (aspect > 1 ? aspect : 1);
    const sy = (0.92 * soul.view.scale) * (aspect < 1 ? aspect : 1);
    const ndcX = ((clientX - rect.left) / soul.W) * 2 - 1;
    const ndcY = 1 - ((clientY - rect.top) / soul.H) * 2;
    return { x: ndcX / sx - soul.view.x, y: ndcY / sy - soul.view.y };
}

function soulPick(wx, wy, radius) {
    const cx = Math.floor(wx / soul.cell), cy = Math.floor(wy / soul.cell);
    let best = null, bestD = radius * radius;
    for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
            const bucket = soul.grid.get((cx + ox) + ',' + (cy + oy));
            if (!bucket) continue;
            for (const i of bucket) {
                const d = soul.nodes[i];
                const dx = d.x - wx, dy = d.y - wy;
                const d2 = dx * dx + dy * dy;
                if (d2 < bestD) { bestD = d2; best = d; }
            }
        }
    }
    return best;
}

function soulBindInput() {
    const cv = soul.canvas;
    const readout = document.getElementById('soul-readout');

    cv.addEventListener('wheel', e => {
        e.preventDefault();
        const before = soulScreenToWorld(e.clientX, e.clientY);
        const d = Math.max(-40, Math.min(40, e.deltaY));
        soul.view.scale = Math.max(0.4, Math.min(60, soul.view.scale * Math.exp(-d * 0.0025)));
        const after = soulScreenToWorld(e.clientX, e.clientY);
        // Keep the point under the cursor under the cursor.
        soul.view.x += after.x - before.x;
        soul.view.y += after.y - before.y;
        soulDraw();
    }, { passive: false });

    cv.addEventListener('mousedown', e => {
        soul.drag = { x: e.clientX, y: e.clientY, vx: soul.view.x, vy: soul.view.y };
    });
    window.addEventListener('mouseup', () => { soul.drag = null; });
    cv.addEventListener('mousemove', e => {
        if (soul.drag) {
            const a = soulScreenToWorld(e.clientX, e.clientY);
            const b = soulScreenToWorld(soul.drag.x, soul.drag.y);
            soul.view.x = soul.drag.vx + (a.x - b.x);
            soul.view.y = soul.drag.vy + (a.y - b.y);
            soulDraw();
            return;
        }
        // Hover. Pick radius shrinks as you zoom in, so a dense rim doesn't
        // grab the cursor from three documents away.
        const w = soulScreenToWorld(e.clientX, e.clientY);
        const hit = soulPick(w.x, w.y, 0.012 / Math.sqrt(soul.view.scale));
        if (!hit) { readout.hidden = true; return; }
        const cls = soul.classes.find(k => k.uri === hit.type);
        const when = hit.born == null ? 'undated' : ('born at commit ' + hit.born);
        readout.hidden = false;
        readout.innerHTML =
            `<div>${hit.label}</div>` +
            `<div class="soul-readout-type">${cls ? cls.name : shortName(hit.type)} · ${when} · ` +
            `${hit.events} change${hit.events === 1 ? '' : 's'}</div>`;
        const rect = cv.getBoundingClientRect();
        readout.style.left = Math.min(rect.width - 340, e.clientX - rect.left + 14) + 'px';
        readout.style.top = (e.clientY - rect.top + 14) + 'px';
    });
    cv.addEventListener('mouseleave', () => { readout.hidden = true; });
    window.addEventListener('resize', () => { if (currentMode === 'soul') resizeSoulCanvas(); });
}
