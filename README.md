# Git-lex Base Kit (`git-lex-kit-base`)

The foundational system kit for [Git-lex](https://github.com/repolex-ai/git-lex). It provides the core W3C RDF/OWL ontologies, parser vocabularies, frontmatter/markdown extraction schemas, Git commit graph semantics, and the default embedded web UI.

Every Git-lex repository depends on the Base Kit as its underlying semantic foundation. Other domain kits (such as `git-lex-kit-soul`, `git-lex-kit-copia`, `git-lex-kit-pan`, and `git-lex-kit-squad`) build on top of the classes and universal properties declared here.

---

## Installation & Management

The Base Kit is automatically installed when initializing a Git-lex repository:

```bash
# Initialize git-lex in a repository (installs base ontologies by default)
git lex init
```

To update the base ontology, parsers, and web UI to the latest release:

```bash
# In an existing git-lex repo
git lex kit-update
```

To manually add or re-install the base kit:

```bash
git lex kit-add repolex-ai/git-lex-kit-base
```

---

## Kit Architecture & Layout

Unlike domain kits that scaffold user content folders (like `Soul/` or `Harness/`), the Base Kit configures `install folders: false` in `kit.yml`. It delivers pure infrastructure:

```text
git-lex-kit-base/
├── kit.yml                             # Kit declaration (name: base, install folders: false)
├── ontology/
│   └── git-lex/
│       ├── git-lex.ttl                 # Core application ontology (git-lex: namespace)
│       ├── fm/
│       │   └── fm.ttl                  # Frontmatter parser schema (fm: namespace)
│       ├── md/
│       │   └── md.ttl                  # Markdown document AST & link schema (md: namespace)
│       ├── git/
│       │   └── git.ttl                 # Git parser schema v1
│       └── git2/
│           └── git2.ttl                # Git commit graph schema v2 (git2: namespace)
├── www/                                # Embedded Web UI & graph explorer
│   ├── index.html                      # Single-page visual query explorer
│   ├── css/main.css                    # UI styles
│   └── js/main.js                      # SPARQL query execution & visualization client
└── reference/
    ├── EXAMPLE-KIT.ttl                 # Reference template for authoring custom kits
    └── check-kit-ontology.py           # Ontology validator and linter for kit authors
```

---

## The Base Ontologies

The Base Kit declares four coordinated namespaces that represent the physical, syntactic, semantic, and temporal layers of a Git repository:

```
                      ┌────────────────────────┐
                      │     git-lex:Thing      │
                      │  (Universal Identity)  │
                      └───────────┬────────────┘
                                  │
         ┌────────────────────────┼────────────────────────┐
         │                        │                        │
┌────────┴─────────┐     ┌────────┴─────────┐     ┌────────┴─────────┐
│  git-lex:Document│     │   git-lex:File   │     │  git2:Commit     │
│ (Typed Document) │     │ (Physical File)  │     │ (Git Commit DAG) │
└──────────────────┘     └────────┬─────────┘     └──────────────────┘
                                  │
                         ┌────────┴─────────┐
                         │   git-lex:fileId │
                         │ (Edge from Thing)│
                         └──────────────────┘
```

### 1. Core Ontology (`git-lex:`)
* **Namespace:** `https://repolex.ai/ontology/git-lex/` (`git-lex:`)
* **Authority:** `ontology/git-lex/git-lex.ttl`
* Represents Git-lex's own machinery for tracking documents and statements:
  * `git-lex:Thing`: The universal base class for any identifiable entity with a stable IRI.
  * `git-lex:Document`: A markdown document managed by Git-lex.
  * `git-lex:File`: The physical file node in the repository tree.
  * `git-lex:SpoEvent`: Event-sourced statement tracking representing added or removed triples across Git commits.

### 2. Frontmatter Parser Schema (`fm:`)
* **Namespace:** `https://repolex.ai/ontology/git-lex/fm/` (`fm:`)
* **Authority:** `ontology/git-lex/fm/fm.ttl`
* Maps YAML frontmatter keys from markdown files directly into typed RDF statements during extraction.

### 3. Markdown Parser Schema (`md:`)
* **Namespace:** `https://repolex.ai/ontology/git-lex/md/` (`md:`)
* **Authority:** `ontology/git-lex/md/md.ttl`
* Captures the syntactic structure of markdown documents:
  * Headings, code blocks, bulleted lists, and blockquotes.
  * Extracted markdown links (`md:linksTo`), root-relative links, and symbol `@mentions`.

### 4. Git Graph Schema (`git2:`)
* **Namespace:** `https://repolex.ai/ontology/git-lex/git2/` (`git2:`)
* **Authority:** `ontology/git-lex/git2/git2.ttl`
* Models the immutable Git history as an RDF Directed Acyclic Graph (DAG):
  * `git2:Commit`: Represents a Git commit with its hash, message, author, committer, and timestamps.
  * `git2:parent`: Edges linking commits to their parents.
  * `git2:tree`: Root tree pointers capturing exact tree states.

---

## Universal Property Conventions

All kits inheriting from Base Kit follow these architectural laws:

1. **Entity Identity (`id`)**:
   Entities declare `id: <namespace/Class/identifier>`. Identity binds to the universal URI, not the file path, so that facts survive file renames and moves.
2. **File Binding (`fileId`)**:
   Stamped automatically by `git-lex` at save (`git-lex:File/<path>`). Never authored manually; re-derived automatically when files move.
3. **Cross-Entity Linking (`relatedToId`)**:
   Multi-valued predicate allowing any `Thing` in any kit to establish semantic relationships with other entities.
4. **Date Naming Convention (`<what>Date`)**:
   Per ecosystem naming rules (v0.18+), all date properties specify what the date is and end in `Date`:
   * `createdDate` (formerly `dateCreated`)
   * `updatedDate` (formerly `dateUpdated`)
   * `earthDate`, `producedDate`, `readyDate`

---

## Kit Authoring & Validation

When creating a new domain kit that extends the Base Kit:

1. **Reference Template:** Inspect [`reference/EXAMPLE-KIT.ttl`](reference/EXAMPLE-KIT.ttl) for SHACL shape patterns, OWL class hierarchies, and property declarations.
2. **Validation Script:** Run the kit validator to ensure proper namespaces, RDFS comments, and SHACL conformance:

```bash
python3 reference/check-kit-ontology.py path/to/your-kit.ttl
```
