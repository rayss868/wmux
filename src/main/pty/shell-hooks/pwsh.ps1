# wmux shell integration hook for PowerShell 5.1 / 7+
# Emits OSC 7 (CWD) and OSC 7727 (git branch) on every prompt render.

if ($env:WMUX_SHELL_HOOK_ACTIVE -eq '1') { return }
$env:WMUX_SHELL_HOOK_ACTIVE = '1'

# Preserve the original prompt so user customisations are not lost.
if (Test-Path Function:\prompt) {
    Copy-Item Function:\prompt Function:\__wmux_original_prompt
}

function prompt {
    # --- OSC 7: Current Working Directory ---
    $cwd = (Get-Location).ProviderPath
    $hostname = [System.Net.Dns]::GetHostName()
    # file:// URI with forward slashes
    $uri = 'file://' + $hostname + '/' + ($cwd -replace '\\', '/')
    [Console]::Write("`e]7;$uri`a")

    # --- OSC 7727: Git branch (best-effort) ---
    $gitExe = Get-Command git -ErrorAction SilentlyContinue
    if ($gitExe) {
        $branch = & git rev-parse --abbrev-ref HEAD 2>$null
        if ($LASTEXITCODE -eq 0 -and $branch) {
            [Console]::Write("`e]7727;$branch`a")
        }
    }

    # Call original prompt to preserve user theme / starship / oh-my-posh etc.
    if (Test-Path Function:\__wmux_original_prompt) {
        return __wmux_original_prompt
    }
    return "PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) "
}
