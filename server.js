const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");
const pino = require("pino");
const { Boom } = require("@hapi/boom");
const { default: makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, fetchLatestBaileysVersion, DisconnectReason, Browsers } = require("@whiskeysockets/baileys");
const configPath = path.join(__dirname, "config.json");
const multer = require("multer");
const upload = multer({ dest: "uploads/" });

const xlsx = require("xlsx");
const { NOMEM } = require("dns");
const req = require("express/lib/request");
const res = require("express/lib/response");

const SESSION_FOLDER = "./session";
let sock;
let wsClient = null;
let status = "Menunggu Respon Server";
let lastQrCode = null;
let o = {};
const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
if (config.wmai === "1") {
  o = { ai: true };
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.get("/qr", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

app.post("/api/blass", upload.single("fileInput"), async (req, res) => {
  const { message, delayInput } = req.body;
  const file = req.file;

  if (!file) {
    return res.status(400).send("File tidak ditemukan");
  }

  // Segera arahkan pengguna ke halaman utama
  res.redirect("../proses.html");

  // Proses pengolahan file dan pengiriman pesan dijalankan di background
  setImmediate(async () => {
    try {
      const workbook = xlsx.readFile(file.path);
      const sheet_name_list = workbook.SheetNames;
      const sheet = workbook.Sheets[sheet_name_list[0]];
      const data = xlsx.utils.sheet_to_json(sheet);

      console.log("Pesan:", message);
      console.log("Data dari file Excel:", data);

      const config = JSON.parse(fs.readFileSync(configPath));
      const delaywaktu = config.defaultDelay;

      console.log("Delay waktu:", delaywaktu);

      // Looping pengiriman pesan
      for (let i = 0; i < data.length; i++) {
        await delay(delaywaktu * 1000); // Delay antar pengiriman pesan
        const target = data[i]["Nomer Target"];
        console.log("Mengirim ke:", target);

        let sendlog = await sock.sendMessage(target + "@s.whatsapp.net", { text: message }, o);
        console.log(sendlog);
      }

      // Hapus file setelah proses selesai
      fs.unlinkSync(file.path);
    } catch (error) {
      console.error(error);
    }
  });
});
app.post("/api/send-message", async (req, res) => {
  const data = req.body;
  console.log(data);

  if (!data.phoneNumber || !data.message) {
    console.log("Data error: phoneNumber atau message tidak ada.");
    return res.status(400).send("Nomor atau pesan tidak lengkap");
  }
  if (!/^[0-9]+$/.test(data.phoneNumber)) {
    console.log("Nomor tidak valid");
    return res.status(400).send("Nomor telepon tidak valid");
  }

  try {
    let sendlog = await sock.sendMessage(data.phoneNumber + "@s.whatsapp.net", { text: data.message }, o);
    console.log("Pesan terkirim:", sendlog);

    res.redirect("/"); // Redirect setelah pengiriman berhasil
  } catch (error) {
    console.error("Error mengirim pesan:", error);
    res.status(500).send("Terjadi kesalahan saat mengirim pesan");
  }
});

app.get("/api/settings", (req, res) => {
  try {
    const raw = fs.readFileSync(configPath);
    return res.json(JSON.parse(raw));
  } catch (err) {
    let defaultSettings = {
      defaultDelay: 1,
      wmai: 0,
    };
    return res.json(defaultSettings); // Tidak perlu JSON.parse() di sini
  }
});
app.post("/api/settings", (req, res) => {
  try {
    const settings = {
      defaultDelay: parseInt(req.body.defaultDelay) || 1,
      wmai: parseInt(req.body.wmai) || 0,
    };
    fs.writeFileSync(configPath, JSON.stringify(settings, null, 2));
    res.json({ success: true });
  } catch (err) {
    console.error("Error menyimpan pengaturan:", err);
    res.status(500).json({ error: "Gagal menyimpan pengaturan" });
  }
});
app.post("/api/login-number", async (req, res) => {
  const { phoneLogin } = req.body;
  if (typeof phoneLogin === "string" && /^[0-9]{5,20}$/.test(phoneLogin)) {
    const phoneNumber = phoneLogin.replace(/[^0-9]/g, "");
    try {
      const code = await sock.requestPairingCode(phoneNumber);
      const formattedCode = code?.match(/.{1,4}/g)?.join("-") || code;
      console.log("Your Pairing Code :", formattedCode);
      res.json({ otp: `Your Pairing Code : ${formattedCode}` });
    } catch (err) {
      console.error("Gagal ambil pairing code:", err);
      res.status(500).json({ error: "Gagal ambil pairing code" });
    }
  } else {
    res.status(400).json({ message: "Masukkan nomor dengan benar (angka saja)" });
  }
});

wss.on("connection", (ws) => {
  wsClient = ws;
  if (status && wsClient.readyState === WebSocket.OPEN) {
    wsClient.send(JSON.stringify({ status }));
  }
  if (lastQrCode && wsClient.readyState === WebSocket.OPEN) {
    wsClient.send(JSON.stringify({ qrBase64: lastQrCode, status: "Silakan scan QR" }));
  }
  wsClient.send(
    JSON.stringify({
      type: "info",
      message: "WebSocket server terhubung!",
    })
  );
});

app.get("/api/status", (req, res) => {
  res.json({ status });
});

async function startSocket() {
  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);
  console.log("start koneksi");

  sock = makeWASocket({
    logger: pino({
      level: "silent",
    }),
    version,
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.ubuntu("Chrome"),
    markOnlineOnConnect: true,
    syncFullHistory: false,
    getMessage: async () => ({}),
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    console.log(update);
    if (qr) {
      const qrBase64 = await QRCode.toDataURL(qr);
      lastQrCode = qrBase64;
      if (wsClient && wsClient.readyState === WebSocket.OPEN) {
        wsClient.send(JSON.stringify({ qrBase64, status: "Silakan scan QR" }));
      }
    }

    if (connection === "open") {
      status = "Tersambung";
      console.log("Wa Tersambung");
      if (wsClient && wsClient.readyState === WebSocket.OPEN) {
        wsClient.send(JSON.stringify({ status }));
      }
    } else if (connection === "close") {
      const reason = new Boom(lastDisconnect?.error)?.output.statusCode;
      if ([DisconnectReason.connectionLost, DisconnectReason.connectionClosed, DisconnectReason.restartRequired, DisconnectReason.timedOut].includes(reason)) {
        status = "Reconnect...";
        console.log(status);
        await startSocket();
      } else if ([DisconnectReason.badSession, DisconnectReason.multiDeviceMismatch, DisconnectReason.loggedOut].includes(reason)) {
        status = "Session rusak, menghapus...";
        console.log(status);
        fs.rmSync(SESSION_FOLDER, { recursive: true, force: true });
        startSocket();
      } else {
        status = `Disconnected: ${reason}`;
        console.log(status);
      }
    }
  });
}

server.listen(80, () => {
  console.log("Server running at http://localhost:80");
  startSocket();
});
