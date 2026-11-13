# 🦙 llamacpp-ui-manager

A TypeScript CLI and Interactive Terminal UI (TUI) for scanning, organizing, and configuring `.gguf` models (including `mmproj` vision projectors and `mtp` / `model-draft` speculative models) for **`llama serve --models-preset`**.

---

## Features

1. **GGUF Binary Header Scanner & Role Classifier**
   - Reads GGUF v2/v3 binary headers directly (with filename fallback) without loading multi-gigabyte tensor weights into memory.
   - Detects **main models**, **multimodal projectors (`mmproj`)**, **Multi-Token Prediction / draft models (`mtp` / `model-draft`)**, and **multi-part split shards** (`*-00001-of-00003.gguf`).
   - Automatically pairs `mmproj` and `mtp` files with their parent model family and base name.

2. **Safe In-Place Directory Organizer**
   - Computes a dry-run migration plan and reorganizes scattered `.gguf` files into a clean hierarchy:
     ```text
     <models_root>/
       └── <family>/                  (e.g., llama, qwen2, gemma3)
           └── <model-name>/          (e.g., Qwen2.5-VL-7B-Instruct)
               ├── mmproj-<...>.gguf  (shared across quantizations)
               ├── mtp-<...>.gguf     (shared across quantizations)
               └── <quantization>/    (e.g., Q4_K_M, Q8_0)
                   └── <model>.gguf
     ```
   - Automatically cleans up empty directories left behind after moving files.

3. **`llama serve --models-preset` Generator & Manager**
   - Generates and updates INI preset files with:
     - **`[*]` Common Section**: Global defaults (`jinja`, `device`, `split-mode`, `reasoning`, `parallel`, `top-p`, `top-k`, `temp`, `flash-attn`, `n-gpu-layers`, `ctx-size`, etc.) plus custom `key = value` or valueless toggle flags.
     - **`[<model-id>]` Sections**: Per-model paths (`model`, `mmproj`, `model-draft`), hardware settings (including `n-cpu-moe` and `n-gpu-layers` for MoE models), sampling overrides, chat templates, and custom `key = value` or valueless toggle flags.
     - **Conditional `model-draft` Options**: Automatically unlocks `spec-type` (defaulting to `draft-mtp`), `cache-type-k-draft`, `cache-type-v-draft`, `n-gpu-layers-draft`, `spec-draft-n-max`, and `spec-draft-p-min` **only** when `model-draft` is present, and excludes them when `model-draft` is absent.

4. **Interactive Terminal UI (TUI)**
   - Built with React & Ink for fast keyboard-driven navigation, responsive terminal resizing, a pinned top menu bar, and vertical-only scrolling:
     - **Tab 1 (`1. Models Config` — Default View)**:
       - Collapsible/expandable model tree (`[Space]` / `[←/→]` to expand/collapse a model, `[a]` to expand/collapse all) with a `●` test status indicator at the left of every model and configuration (**gray** = not ran, **green** = passed, **red** = failed).
       - **Enable / Disable Models for Export (`[x]`)**: Toggle models or configurations with `[x]` (`[✓]` enabled / `[✗]` disabled). All configurations are always archived to `.all_configs_available.ini` in the models directory, while only enabled models are exported to the user preset file.
       - **Inherited Value Display**: Unset per-model parameters and custom flags that inherit a value from `[*]` show the inherited value in parentheses (`(value) ← [*]`).
       - **Multi-Configuration / Mixture Builder (`[v]`)**: Enable or disable any mixture of a model's available elements (`Base Only`, `Base + Vision (mmproj)`, `Base + MTP (model-draft)`, `Base + Vision + MTP`, or custom-named profiles), and configure each profile independently.
       - **Single, Per-Model, and Global Configuration Testing (`[t]`, `[m]`, `[T]`) & Speed (`t/s`) Comparison**:
         - Automatically extracts and saves average tokens per second (`⚡ XX.XX t/s`) from `llama cli` runs and compares the latest run against the previously saved average (`▲ BETTER` in green vs `▼ WORSE` in red).
         - Press `[t]` on a model row (or `[m]` on a child configuration, or `[t]` inside the Mixture Builder) to sequentially **test all configurations of that model at once**.
         - Press `[T]` (Shift+T) in the Models Config list to sequentially **test all models and all configurations available**.
         - Press `[t]` on a specific configuration (or inside the configuration editor) to test that single configuration and inspect the full command and scrollable `stdout`/`stderr` output. Automatically closes the exact spawned `ChildProcess` PID upon completion, error, or abort.
     - **Tab 2 (`2. [*] Common Settings`)**: Configure global defaults and custom `key = value` or valueless toggle flags (`[c]`).
     - **Tab 3 (`3. Scan & Organize`)**: Inspect discovered model groups, preview the dry-run move plan (`[p]`), and execute in-place organization (`[o]`).
     - **Tab 4 (`4. Test & App Settings`)**: Configure the test command (default: `llama cli`), default test prompt (default: `"why is the sky blue?"`), max predict tokens (`-n 64`), and timeout.

---

## Quick Start

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Launch the Interactive TUI (defaults to current directory & ./models-preset.ini)
npm start -- -d /path/to/models -p /path/to/models-preset.ini
```

### CLI Subcommands

```bash
# 1. Scan a directory and view grouped models, mmproj, and mtp pairings
npx tsx src/cli.tsx scan /path/to/models

# 2. Preview (dry-run) or execute in-place directory organization
npx tsx src/cli.tsx organize /path/to/models --dry-run
npx tsx src/cli.tsx organize /path/to/models

# 3. Generate or update a llama serve --models-preset INI file
npx tsx src/cli.tsx generate-preset /path/to/models -o ./models-preset.ini

# 4. Start llama.cpp server with the generated preset file
llama serve --models-preset ./models-preset.ini
```

### Running Tests

```bash
npm test
```

