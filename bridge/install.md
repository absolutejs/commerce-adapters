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
are what the app calls `printer` for the `os-print` action). The second opens
the socket, does one pass of work and exits. Then run it without `--once`: it
holds the connection open and the app shows the bridge as online immediately.
The bridge only makes **outbound** connections to your app — no port forwarding,
no VPN, no inbound firewall rule.

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

## Measuring machine time (telemetry)

Each machine in the app's settings can have one telemetry source. The bridge
watches whatever the app sends it — nothing is configured on this side beyond
the ports below. Every path is push- or event-driven; the bridge never asks a
machine for its status on a timer. Use `--probe` to check a source before you
save it, and `--telemetry-help <kind>` for the plain-English explanation.

### Production report folder (embroidery heads, DTG/DTF RIPs)

1. In the machine's software (Tajima DG / Network Manager, Melco OS, Barudan
   LEM, the Ricoma panel, or the RIP's job-log settings) switch on writing a
   production report per run and note the folder it writes to.
2. Make sure the bridge computer can read that folder — a local path, or a
   mapped share like `\\SHOP-PC\Reports`.
3. Test it: `bunx @absolutejs/machines-bridge --probe report-folder --path
"\\SHOP-PC\Reports" --parser tajima-report`. It prints the reading it got
   from the newest file.
4. Files already in the folder when the bridge first sees it are adopted, not
   re-imported, and nothing is ever moved or deleted. A `.absolutejs-seen`
   sidecar is written there so a restart does not replay history.

On network shares the OS sometimes drops change notifications, so the bridge
also rescans the folder every five minutes as a safety net.

### Zebra and Zebra-compatible label printers

The printer pushes alerts; the bridge holds a connection open to read them and
also listens on TCP 9200 for printers configured to dial the bridge PC.
Configure the alerts once from a PC on the same network — send this to port
9100 (adjust the address to the bridge computer):

```
~SXA,C,Y,Y,192.168.1.99,9200      # media out, set and clear
~SXB,C,Y,Y,192.168.1.99,9200      # ribbon out
~SXD,C,Y,Y,192.168.1.99,9200      # printhead open
~SXP,C,Y,Y,192.168.1.99,9200      # printer paused
~SXQ,C,Y,Y,192.168.1.99,9200      # batch (PQ) completed
```

Link-OS printers can do the same through `alerts.add` in the printer's web
page (Alerts → Add), destination TCP, address = the bridge PC, port 9200.
Check the connection first with
`bunx @absolutejs/machines-bridge --probe raw-tcp-status --host 192.168.1.50`,
which sends one `~HS` and prints the decoded status. Allow inbound TCP 9200 on
the bridge computer's firewall.

### SNMP traps (networked DTG/DTF/sublimation and office-class printers)

In the printer's web page find SNMP (often under Network → Protocols):

1. Enable SNMP v1/v2c and note the community string (`public` unless the shop
   changed it).
2. Add a **trap destination**: the bridge computer's IP, UDP port 162.
3. Test the read path with
   `bunx @absolutejs/machines-bridge --probe snmp-printer --host 192.168.1.60`.

Ports below 1024 need root on Linux/macOS. Either run the service as root, give
Bun the capability (`sudo setcap 'cap_net_bind_service=+ep' ~/.bun/bin/bun`), or
set the printer's trap port to something above 1024 and put the same number in
the app's machine settings. Allow inbound UDP 162 on the firewall.

### Webhook from the machine's software

The bridge serves `http://<bridge-pc>:8787/telemetry/<machine-id>` (change the
port with `--webhook-port`). Paste that URL, plus the secret from the app's
machine settings, into the RIP or controller's notification/webhook settings —
Kornit, Kothari, Caldera, VersaWorks and several DTG and laser controllers have
one. The bridge accepts JSON or plain text and rejects posts without the
secret. Allow inbound TCP 8787 on the firewall.

If a machine's software cannot notify anything and can only be asked, leave
that machine on **manual** in the app. Manual measures nothing and says so —
that is better than a number nobody can trust.
