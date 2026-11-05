# AnySys

AnySys is a portable Windows app for sharing one monitor with a friend. Either person can host. The host approves each session and can grant view-only access or mouse and keyboard control. Sharing can include Windows system audio.

## Open the app

Use the x64 portable EXE on both Windows 10 or 11 PCs. From source, use Node.js 22 or newer on x64 Windows.

```powershell
npm ci
npm start
```

Run `npm run dist` to build `dist/AnySys-1.0.0-x64.exe`. The portable build is unsigned. The native helper is compiled with the Windows .NET Framework 4.x compiler and bundled with the app.

## On the same home network

1. Start signaling on one PC from this source directory. You can run it on either PC.

   ```powershell
   npm ci --omit=dev
   $env:HOST = '0.0.0.0'
   npm run signal
   ```

   If Windows Firewall prompts you, allow Node.js on **Private networks**. On the signaling PC, use `ipconfig` to find its LAN IPv4 address.

2. On the PC sharing its screen, open **Host network settings** and enter `ws://<signaling-PC-LAN-IP>:8787/signal`. Leave ICE servers empty on the same LAN. The default `ws://127.0.0.1:8787/signal` is for testing both app instances on one PC.
3. Select the monitor and optionally enable **Share system audio**. Click **Create invite** and send the invite to your friend in a private message.
4. Your friend pastes it into **Connect to a friend** and clicks **Request access**. On the host, check **Allow mouse and keyboard control** if you want to grant it, then click **Approve and share**.
5. The viewer clicks inside the remote display to type. **Ctrl+Shift+F8** releases keyboard focus in the viewer. The host can click **Stop sharing** on the floating toolbar or press **Ctrl+Alt+Shift+F12** on the host keyboard.

If you plan to run the desktop app from source in the same directory, use the full `npm ci` once and run `npm run signal` and `npm start` in separate PowerShell windows.

## Across the internet

Use this setup when the two PCs are on different networks. Signaling pairs the clients, and TURN relays the encrypted session when the networks block a direct connection. Neither home router needs port forwarding.

1. Put this source in a Git repository accessible to Render. Create a [Render Blueprint](https://render.com/docs/infrastructure-as-code) from that repository. The included `render.yaml` creates one Docker web service with the `/health` endpoint. Keep it on a single instance because both PCs must connect to the same in-memory invite. Copy its public hostname once the deploy is live. [Render WebSocket docs](https://render.com/docs/websocket)
2. Create a [Cloudflare Realtime TURN key](https://developers.cloudflare.com/realtime/turn/generate-credentials/). On the host PC, run this from the project directory with your Render hostname. The script waits for signaling to wake up, prompts for the TURN key ID and API token, and copies temporary ICE server settings to the clipboard. It sends the long-lived API token only to Cloudflare.

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/prepare-online.ps1 -SignalingUrl 'wss://<your-service-hostname>/signal'
   ```

3. On the host PC, open **Host network settings** in AnySys. Enter the same signaling URL and paste the copied JSON into **ICE servers**. For the first call, enable **Require a TURN relay** to verify that the relay works. Create an invite and send it privately to your friend.
4. On their separate network, your friend opens the same EXE and pastes the invite. The invite supplies both the signaling address and the temporary TURN configuration. Approve the request, confirm that the viewer receives the desktop, and test a click or keystroke with control enabled. You can turn off **Require a TURN relay** on later calls to let AnySys use a direct connection when available.

Run the preparation command again when the temporary credentials expire. The default is eight hours, and you can adjust it with `-Hours`. Free Render services can take about a minute to wake after inactivity. [Render free service behavior](https://render.com/docs/free)

If you already have a TURN provider, paste its ICE settings directly. Include a TLS endpoint on TCP port 443 if your provider offers it, so the app can fall back when a network restricts UDP.

```json
[
  {
    "urls": ["turn:relay.example.com:3478", "turns:relay.example.com:443?transport=tcp"],
    "username": "your-turn-username",
    "credential": "your-turn-password"
  }
]
```

The signaling server can also run with `docker build -t anysys-signal .` and `docker run --rm -p 127.0.0.1:8787:8787 anysys-signal` behind your own TLS reverse proxy.

## Session behavior

- Invites are single-use and expire after ten minutes if nobody joins. Both peers authenticate signaling messages with a key contained in the invite. WebRTC encrypts the video, optional audio, and control traffic. Treat the invite as a password.
- Sharing requires an unlocked Windows desktop and approval for every session. Locking or suspending the host, changing the display configuration, closing the app, or losing the connection ends the session.
- Windows `SendInput` can control ordinary desktop apps at the host’s integrity level or below. UAC secure desktop, the lock screen, administrator windows from a standard session, and Ctrl+Alt+Del are outside the supported control surface.
- Keyboard control forwards physical key positions. Matching Windows keyboard layouts give the closest typing behavior. Windows may intercept system shortcuts on the viewer before AnySys sees them.
- If the viewer connects but shows no frames, check that the host desktop is unlocked. If the peer connection times out, check TURN reachability and credentials. If the viewer joins but the host cannot approve control, check that **Ctrl+Alt+Shift+F12** is available on the host.

Run `npm test` to check invite authentication, room isolation, and input validation.
