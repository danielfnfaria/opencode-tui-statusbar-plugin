#!/usr/bin/env bash
# Idempotent installer for the opencode TUI statusbar plugin.
#
#   ./install.sh                 # show the change and ask before writing
#   ./install.sh --yes           # apply without asking
#   ./install.sh --dry-run       # show the change, never write
#   ./install.sh --remove        # uninstall (copied file + tui plugin entry)
#   ./install.sh --config-dir D  # target config dir (default: $OPENCODE_CONFIG_DIR or ~/.config/opencode)
set -euo pipefail

VERSION="0.1.0"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$ROOT/plugin/statusbar.tsx"
INSTALLED_NAME="opencode-tui-statusbar.tsx"
ENTRY="./$INSTALLED_NAME"

YES=0
DRY=0
REMOVE=0
CFG=""

usage() {
  sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes | -y) YES=1 ;;
    --dry-run | -n) DRY=1 ;;
    --remove) REMOVE=1 ;;
    --config-dir) CFG="${2:?--config-dir needs a value}"; shift ;;
    --config-dir=*) CFG="${1#*=}" ;;
    -h | --help) usage; exit 0 ;;
    *) echo "install.sh: unknown flag: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

CFG="${CFG:-${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}}"
DEST="$CFG/$INSTALLED_NAME"

command -v node >/dev/null 2>&1 || { echo "install.sh: node is required" >&2; exit 1; }
[[ -f "$SRC" ]] || { echo "install.sh: missing $SRC" >&2; exit 1; }

# ---- file copy (install) / file removal (remove) ----
COPY_NEEDED=0
if [[ $REMOVE -eq 0 ]] && ! cmp -s "$SRC" "$DEST"; then
  COPY_NEEDED=1
fi

run_node() { # $1 = APPLY (0|1)
  CFG="$CFG" ENTRY="$ENTRY" MODE="$([[ $REMOVE -eq 1 ]] && echo remove || echo install)" APPLY="$1" \
    DEPS_JSON='{"solid-js":"^1.9.0","@opentui/core":"0.1.97","@opentui/solid":"0.1.97"}' \
    node <<'NODE_EOF'
const fs = require("node:fs");
const path = require("node:path");

const cfg = process.env.CFG;
const entry = process.env.ENTRY;
const mode = process.env.MODE;
const apply = process.env.APPLY === "1";
const deps = JSON.parse(process.env.DEPS_JSON);

function stripJsonc(src) {
  let out = "", i = 0, inStr = false, quote = "";
  while (i < src.length) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (c === "\\") { out += src[i + 1] ?? ""; i += 2; continue; }
      if (c === quote) inStr = false;
      i++; continue;
    }
    if (c === '"') { inStr = true; quote = c; out += c; i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    out += c; i++;
  }
  return out;
}

function readJson(file, jsonc) {
  const raw = fs.readFileSync(file, "utf8");
  return JSON.parse(jsonc ? stripJsonc(raw) : raw);
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
}

const actions = [];   // { line, run }
const notes = [];

// ---- package.json deps ----
const pkgFile = path.join(cfg, "package.json");
if (mode === "install") {
  let pkg = {};
  let existed = false;
  if (fs.existsSync(pkgFile)) { pkg = readJson(pkgFile, false); existed = true; }
  const missing = Object.entries(deps).filter(([k, v]) => {
    const cur = pkg?.dependencies?.[k];
    return cur === undefined;
  });
  const kept = Object.entries(deps).filter(([k]) => pkg?.dependencies?.[k] !== undefined);
  if (missing.length > 0) {
    actions.push({
      line: `[deps] ${pkgFile}: ${existed ? "" : "create + "}add ${missing.map(([k, v]) => `${k}@${v}`).join(", ")}`,
      run: () => {
        const cur = fs.existsSync(pkgFile) ? readJson(pkgFile, false) : {};
        cur.dependencies = { ...(cur.dependencies ?? {}), ...Object.fromEntries(missing) };
        writeJson(pkgFile, cur);
      },
    });
  }
  for (const [k, v] of kept) {
    if (pkg.dependencies[k] !== v) notes.push(`kept existing ${k}@${pkg.dependencies[k]} (wanted ${v})`);
  }
}

// ---- tui.json / tui.jsonc plugin entry ----
const tuiJson = path.join(cfg, "tui.json");
const tuiJsonc = path.join(cfg, "tui.jsonc");
let tuiFile = fs.existsSync(tuiJson) ? tuiJson : fs.existsSync(tuiJsonc) ? tuiJsonc : null;

if (mode === "install") {
  if (!tuiFile) tuiFile = tuiJson;
  const jsonc = tuiFile.endsWith(".jsonc");
  let tui = fs.existsSync(tuiFile) ? readJson(tuiFile, jsonc) : { $schema: "https://opencode.ai/tui.json" };
  const plugin = Array.isArray(tui.plugin) ? tui.plugin : [];
  const has = plugin.some((p) => (typeof p === "string" ? p === entry : Array.isArray(p) && p[0] === entry));
  if (!has) {
    if (jsonc) notes.push(`${path.basename(tuiFile)} will be rewritten without comments`);
    actions.push({
      line: `[tui]  ${tuiFile}: plugin[] += "${entry}"${fs.existsSync(tuiFile) ? "" : " (new file)"}`,
      run: () => {
        const cur = fs.existsSync(tuiFile) ? readJson(tuiFile, jsonc) : { $schema: "https://opencode.ai/tui.json" };
        cur.plugin = [...(Array.isArray(cur.plugin) ? cur.plugin : []), entry];
        writeJson(tuiFile, cur);
      },
    });
  }
} else if (tuiFile) {
  const jsonc = tuiFile.endsWith(".jsonc");
  const tui = readJson(tuiFile, jsonc);
  const plugin = Array.isArray(tui.plugin) ? tui.plugin : [];
  const has = plugin.some((p) => (typeof p === "string" ? p === entry : Array.isArray(p) && p[0] === entry));
  if (has) {
    if (jsonc) notes.push(`${path.basename(tuiFile)} will be rewritten without comments`);
    actions.push({
      line: `[tui]  ${tuiFile}: plugin[] -= "${entry}"`,
      run: () => {
        const cur = readJson(tuiFile, jsonc);
        cur.plugin = (Array.isArray(cur.plugin) ? cur.plugin : []).filter(
          (p) => !(typeof p === "string" ? p === entry : Array.isArray(p) && p[0] === entry),
        );
        writeJson(tuiFile, cur);
      },
    });
  }
}

if (actions.length === 0) {
  process.exit(4);
}

for (const a of actions) console.log(a.line);
for (const n of notes) console.log("note:  " + n);

if (apply) {
  for (const a of actions) a.run();
  console.log("done:  config changes written.");
}
NODE_EOF
}

MODE_WORD="install"
[[ $REMOVE -eq 1 ]] && MODE_WORD="uninstall"

echo "opencode-tui-statusbar-plugin v$VERSION — $MODE_WORD into $CFG"

set +e
run_node 0
RC=$?
set -e
if [[ $RC -ne 0 && $RC -ne 4 ]]; then exit $RC; fi
DEST_EXISTS=0
[[ -f "$DEST" ]] && DEST_EXISTS=1
if [[ $RC -eq 4 && $COPY_NEEDED -eq 0 && ! ( $REMOVE -eq 1 && $DEST_EXISTS -eq 1 ) ]]; then
  echo "nothing to do: already $([[ $REMOVE -eq 1 ]] && echo removed || echo installed)."
  exit 0
fi

if [[ $REMOVE -eq 0 && $COPY_NEEDED -eq 1 ]]; then
  echo "[copy] $SRC -> $DEST"
fi
if [[ $REMOVE -eq 1 && -f "$DEST" ]]; then
  echo "[rm]   $DEST"
fi

if [[ $DRY -eq 1 ]]; then
  echo "dry-run: nothing written."
  exit 0
fi

if [[ $YES -eq 0 ]]; then
  printf 'apply these changes? [y/N] '
  read -r ANSWER || ANSWER=""
  case "$ANSWER" in
    y | Y | yes | YES) ;;
    *) echo "aborted."; exit 1 ;;
  esac
fi

if [[ $REMOVE -eq 0 && $COPY_NEEDED -eq 1 ]]; then
  mkdir -p "$CFG"
  cp "$SRC" "$DEST"
fi
if [[ $REMOVE -eq 1 && -f "$DEST" ]]; then
  rm -f "$DEST"
fi

if [[ $RC -eq 0 ]]; then run_node 1; fi

if [[ $REMOVE -eq 0 ]]; then
  echo "restart opencode for the plugin to load (config is not hot-reloaded)."
else
  echo "restart opencode to finish the removal."
fi
