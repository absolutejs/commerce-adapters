# Installing the bridge in the shop

You need one computer on the shop network that stays on during working hours
— a Windows PC by the front desk, a Mac, a Linux box, or a Raspberry Pi. The
computer must be able to reach the printers (same Wi-Fi/LAN) and the internet.

## 1. Install Bun

- macOS / Linux / Raspberry Pi: `curl -fsSL https://bun.sh/install | bash`
- Windows: `powershell -c "irm bun.sh/install.ps1 | iex"`

## 2. Get a token

In the app's **Machines → Bridge** settings create a bridge (e.g.
"front-desk-pc") and copy its token. One token per computer; revoke it there
if the computer is retired.

## 3. Try it once

```sh
bunx @absolutejs/machines-bridge --list-printers
bunx @absolutejs/machines-bridge --server https://shop.example --token XXXX --once
```

The first command shows the print queues this computer can see (their names
are what the app calls `printer` for the `os-print` action). The second polls
one time and exits. Then run without `--once` and the app should show the
bridge as online within a few seconds.

## Run it as a service

### Linux / Raspberry Pi (systemd)

`/etc/systemd/system/absolutejs-bridge.service`:

```ini
[Unit]
Description=AbsoluteJS machines bridge
After=network-online.target
Wants=network-online.target

[Service]
User=pi
Environment=ABS_BRIDGE_SERVER=https://shop.example
Environment=ABS_BRIDGE_TOKEN=XXXX
ExecStart=/home/pi/.bun/bin/bunx @absolutejs/machines-bridge
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now absolutejs-bridge
journalctl -u absolutejs-bridge -f     # logs
```

For `os-print` on Linux install CUPS (`sudo apt install cups`) and add the
printer with `lpadmin` or the CUPS web UI at http://localhost:631; the `User`
must be allowed to print. Raw (ZPL/EPL) queues: create the queue with
`lpadmin -p Zebra -E -v socket://192.168.1.50:9100 -m raw`.

Raspberry Pi notes: Bun ships arm64 builds — use a 64-bit Raspberry Pi OS
(Pi 3B+/4/5). Put `ABS_BRIDGE_TOKEN` in `/etc/absolutejs-bridge.env` with
`EnvironmentFile=` instead of inline if other people log in to the Pi.

### macOS (launchd)

`~/Library/LaunchAgents/ai.absolutejs.bridge.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ai.absolutejs.bridge</string>
  <key>ProgramArguments</key><array>
    <string>/Users/shop/.bun/bin/bunx</string>
    <string>@absolutejs/machines-bridge</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>ABS_BRIDGE_SERVER</key><string>https://shop.example</string>
    <key>ABS_BRIDGE_TOKEN</key><string>XXXX</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/absolutejs-bridge.log</string>
  <key>StandardErrorPath</key><string>/tmp/absolutejs-bridge.log</string>
</dict></plist>
```

`launchctl load ~/Library/LaunchAgents/ai.absolutejs.bridge.plist`

### Windows

**Task Scheduler** (simplest): Create Task → _Run whether user is logged on or
not_ → Trigger _At startup_ → Action _Start a program_:

- Program: `C:\Users\<you>\.bun\bin\bunx.exe`
- Arguments: `@absolutejs/machines-bridge --server https://shop.example --token XXXX`

Tick _If the task fails, restart every 1 minute_. Logs go nowhere by default;
add `>> C:\bridge.log 2>&1` via a small `.cmd` wrapper if you want them.

**NSSM** (runs as a real Windows service, recommended for a front-desk PC):

```
nssm install AbsoluteJSBridge "C:\Users\<you>\.bun\bin\bunx.exe" "@absolutejs/machines-bridge"
nssm set AbsoluteJSBridge AppEnvironmentExtra ABS_BRIDGE_SERVER=https://shop.example ABS_BRIDGE_TOKEN=XXXX
nssm set AbsoluteJSBridge AppStdout C:\bridge.log
nssm set AbsoluteJSBridge AppStderr C:\bridge.log
nssm start AbsoluteJSBridge
```

The `os-print` action uses the printers installed for the account the service
runs as — install the printer for that user, or run the service as the
front-desk user. For Zebra/label printers on Windows use `raw-tcp` to port
9100 instead of `os-print`; Windows drivers do not always pass raw ZPL
through.

## Finding the printer's IP and testing port 9100

- Zebra: hold the feed button until it flashes once, release — it prints a
  configuration label with the IP. Or open the printer's web page.
- Most printers: print the _network configuration_ page from the front panel,
  or look at the DHCP client list on the shop router. Give the printer a
  DHCP reservation so the IP does not change.
- Test from the bridge computer:

  ```sh
  # Linux / macOS
  nc -vz 192.168.1.50 9100
  printf '^XA^FO50,50^ADN,36,20^FDHELLO^FS^XZ' | nc 192.168.1.50 9100   # prints a Zebra test label
  # Windows PowerShell
  Test-NetConnection 192.168.1.50 -Port 9100
  ```

  If `nc`/`Test-NetConnection` cannot connect, check the printer is on the
  same network, that port 9100 ("raw" / "JetDirect") is enabled in its
  network settings, and that a firewall on the PC is not blocking outbound
  connections.

- IPP printers answer at `ipp://<ip>:631/ipp/print` (CUPS queues:
  `ipp://<host>:631/printers/<queue>`). Test with `ipptool -tv
ipp://<ip>:631/ipp/print get-printer-attributes.test` (part of CUPS).
