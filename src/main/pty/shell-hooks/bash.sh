# wmux shell integration hook for Bash (Git Bash / WSL / Linux)
# Emits OSC 7 (CWD) and OSC 7727 (git branch) via PROMPT_COMMAND.

# Guard: skip if already loaded
[ "$WMUX_SHELL_HOOK_ACTIVE" = "1" ] && return 2>/dev/null
export WMUX_SHELL_HOOK_ACTIVE=1

__wmux_prompt_hook() {
    # --- OSC 7: Current Working Directory ---
    local cwd
    # In WSL, convert to a Windows path so the Electron host can resolve it.
    if [ -n "$WSL_DISTRO_NAME" ] && command -v wslpath >/dev/null 2>&1; then
        cwd="$(wslpath -w "$PWD" 2>/dev/null | sed 's|\\|/|g')"
    else
        cwd="$PWD"
    fi
    printf '\e]7;file://%s/%s\a' "${HOSTNAME:-localhost}" "$cwd"

    # --- OSC 7727: Git branch (best-effort) ---
    if command -v git >/dev/null 2>&1; then
        local branch
        branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
        if [ $? -eq 0 ] && [ -n "$branch" ]; then
            printf '\e]7727;%s\a' "$branch"
        fi
    fi
}

# Append to PROMPT_COMMAND, preserving any existing value.
if [ -z "$PROMPT_COMMAND" ]; then
    PROMPT_COMMAND="__wmux_prompt_hook"
else
    PROMPT_COMMAND="__wmux_prompt_hook;${PROMPT_COMMAND}"
fi
