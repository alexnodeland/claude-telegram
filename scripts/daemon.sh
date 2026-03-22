#!/usr/bin/env bash
# Install/uninstall claude-telegram as a system daemon.
# Usage: daemon.sh install | uninstall | status | logs
set -euo pipefail

# Resolve paths
BUN="$(which bun 2>/dev/null || echo "$HOME/.bun/bin/bun")"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ORCHESTRATOR="$SCRIPT_DIR/src/orchestrator.ts"
TOKEN="${TELEGRAM_BOT_TOKEN:-}"
CLAUDE_BIN="${CLAUDE_BIN:-$(which claude 2>/dev/null || echo "claude")}"

if [ -z "$TOKEN" ] && [ "$1" != "uninstall" ] && [ "$1" != "status" ] && [ "$1" != "logs" ]; then
  echo "Error: TELEGRAM_BOT_TOKEN is not set"
  echo "  export TELEGRAM_BOT_TOKEN=your_token_here"
  exit 1
fi

# ── macOS (launchd) ─────────────────────────────────────────────────────────

PLIST="$HOME/Library/LaunchAgents/com.claude-telegram.plist"

install_launchd() {
  cat > "$PLIST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude-telegram</string>
    <key>ProgramArguments</key>
    <array>
        <string>$BUN</string>
        <string>run</string>
        <string>$ORCHESTRATOR</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>TELEGRAM_BOT_TOKEN</key>
        <string>$TOKEN</string>
        <key>CLAUDE_BIN</key>
        <string>$CLAUDE_BIN</string>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:$HOME/.bun/bin</string>
    </dict>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/claude-telegram.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/claude-telegram.log</string>
</dict>
</plist>
EOF
  launchctl load "$PLIST"
  echo "Daemon installed and started."
  echo "  Logs: tail -f /tmp/claude-telegram.log"
  echo "  Stop: $0 uninstall"
}

uninstall_launchd() {
  if [ -f "$PLIST" ]; then
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Daemon stopped and removed."
  else
    echo "No daemon installed."
  fi
}

status_launchd() {
  if launchctl list com.claude-telegram &>/dev/null; then
    echo "Running"
    launchctl list com.claude-telegram
  else
    echo "Not running"
  fi
}

logs_launchd() {
  tail -f /tmp/claude-telegram.log
}

# ── Linux (systemd) ─────────────────────────────────────────────────────────

SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE="$SERVICE_DIR/claude-telegram.service"

install_systemd() {
  mkdir -p "$SERVICE_DIR"
  cat > "$SERVICE" << EOF
[Unit]
Description=Claude Telegram Orchestrator
After=network.target

[Service]
ExecStart=$BUN run $ORCHESTRATOR
Environment=TELEGRAM_BOT_TOKEN=$TOKEN
Environment=CLAUDE_BIN=$CLAUDE_BIN
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now claude-telegram
  echo "Daemon installed and started."
  echo "  Logs: journalctl --user -u claude-telegram -f"
  echo "  Stop: $0 uninstall"
}

uninstall_systemd() {
  if [ -f "$SERVICE" ]; then
    systemctl --user disable --now claude-telegram 2>/dev/null || true
    rm -f "$SERVICE"
    systemctl --user daemon-reload
    echo "Daemon stopped and removed."
  else
    echo "No daemon installed."
  fi
}

status_systemd() {
  systemctl --user status claude-telegram 2>/dev/null || echo "Not running"
}

logs_systemd() {
  journalctl --user -u claude-telegram -f
}

# ── Dispatch ─────────────────────────────────────────────────────────────────

ACTION="${1:-install}"
OS="$(uname -s)"

case "$OS" in
  Darwin)
    case "$ACTION" in
      install)   install_launchd ;;
      uninstall) uninstall_launchd ;;
      status)    status_launchd ;;
      logs)      logs_launchd ;;
      *) echo "Usage: $0 install|uninstall|status|logs"; exit 1 ;;
    esac
    ;;
  Linux)
    case "$ACTION" in
      install)   install_systemd ;;
      uninstall) uninstall_systemd ;;
      status)    status_systemd ;;
      logs)      logs_systemd ;;
      *) echo "Usage: $0 install|uninstall|status|logs"; exit 1 ;;
    esac
    ;;
  *)
    echo "Unsupported OS: $OS"
    echo "Use tmux instead: tmux new-session -d -s claude 'claude-telegram-orchestrator'"
    exit 1
    ;;
esac
