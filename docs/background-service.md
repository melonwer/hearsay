# Run Hearsay as a Linux user service

Hearsay measures while its local server is running. A terminal session stops when you
close it. On a Linux desktop or server with systemd, you can install a user service
manually. This setup uses the real workspace; the demo stays separate and cannot make
provider calls.

1. Complete real-brand setup and any subscription schedule consent in Hearsay. Check
   `GET /api/status` or Settings for enabled schedules and the next occurrence. A
   signed-in CLI alone does not authorize a recurring subscription run.
2. Copy [hearsay.service.example](hearsay.service.example) to
   `~/.config/systemd/user/hearsay.service`. Replace both `/absolute/path/to/hearsay`
   entries with the absolute repository path and `/absolute/path/to/node` with the
   output of `command -v node`. Keep `HEARSAY_DEMO=0`. Do not put API keys in the unit;
   Hearsay reads its `.env` from `WorkingDirectory`. If you enabled a subscription
   runner, set `HEARSAY_CODEX_PATH` or `HEARSAY_CLAUDE_CODE_PATH` in `.env` to the
   absolute path reported by `command -v codex` or `command -v claude`. A user service
   may have a different `PATH` from your terminal.
3. Load and start it explicitly:

   ```sh
   systemctl --user daemon-reload
   systemctl --user enable --now hearsay.service
   systemctl --user status hearsay.service
   ```

4. Open the local URL printed in `journalctl --user -u hearsay.service -n 30` or read
   `data/hearsay.port`. Check `/api/status` and the dashboard's tracking health. The
   service running does not prove a successful observation; the health panel shows the
   last one and any missed or failed occurrence.

Stop or resume the server with `systemctl --user stop hearsay.service` and
`systemctl --user start hearsay.service`. To remove automatic start, run
`systemctl --user disable --now hearsay.service`. These commands affect only your
Hearsay user service. Changes to `.env` need `systemctl --user restart hearsay.service`.

A user service normally depends on your login session. If it must stay running after
logout, ask your administrator to permit user lingering, then run
`loginctl enable-linger "$USER"` and verify it with `loginctl show-user "$USER"`.
The machine must still be awake and connected for measurements. On restart Hearsay
shows stale observations and records eligible missed occurrences; it does not spend
allowance to replay old subscription runs or run a missed API panel immediately.

See the official [systemctl manual](https://www.freedesktop.org/software/systemd/man/latest/systemctl.html),
[service unit manual](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html),
and [loginctl manual](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html)
for the service manager behavior.
