import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import cors from "cors";
import cookieSession from "cookie-session";
import { OAuth2Client } from "google-auth-library";
import * as dotenv from "dotenv";
import axios from "axios";
import { GoogleGenAI, Type } from "@google/genai";

// Load environment variables from .env if it exists
dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  // IMPORTANT: Trust proxy for session cookies to work in Cloud Run / iframes
  app.set('trust proxy', 1);

  // Initialize Gemini
  const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

  // AI Studio provides APP_URL automatically. 
  // We use a fallback logic to ensure it works even if not set correctly in env.
  const getBaseUrl = (req: express.Request) => {
    const envUrl = process.env.APP_URL;
    if (envUrl && !envUrl.includes("your-app-url") && envUrl.startsWith("http")) {
      return envUrl.replace(/\/$/, "");
    }
    const protocol = req.headers["x-forwarded-proto"] || "http";
    const host = req.headers["host"];
    return `${protocol}://${host}`;
  };

  const getClient = (req: express.Request) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    
    if (!clientId || !clientSecret) {
      console.error("CRITICAL: GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is missing.");
    }
    
    const redirectUri = `${getBaseUrl(req)}/auth/callback`;
    console.log("Auth Base URL:", getBaseUrl(req));
    console.log("Using Redirect URI:", redirectUri);
    
    return new OAuth2Client(clientId, clientSecret, redirectUri);
  };

  app.use(cors());
  app.use(express.json({ limit: '50mb' })); // Increase limit for image uploads
  app.use(
    cookieSession({
      name: "ais_session",
      keys: [process.env.SESSION_SECRET || "facematcher-default-secret"],
      maxAge: 24 * 60 * 60 * 1000,
      secure: true,
      sameSite: "none",
      // Adding partitioned: true is not natively supported by cookie-session easily 
      // but we ensure all other flags are correct.
    })
  );

  // --- Auth Routes ---

  app.get("/api/auth/url", (req, res) => {
    const client = getClient(req);
    const url = client.generateAuthUrl({
      access_type: "offline",
      scope: [
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/userinfo.profile",
        "https://www.googleapis.com/auth/userinfo.email",
      ],
      prompt: "consent",
    });
    console.log("Generated Auth URL:", url);
    res.json({ url });
  });

  app.get(["/auth/callback", "/auth/callback/"], async (req, res) => {
    const { code } = req.query;
    console.log("OAuth callback recieved. Code present:", !!code);
    if (!code) return res.status(400).send("No code provided");

    try {
      const authClient = getClient(req);
      const { tokens } = await authClient.getToken(code as string);
      console.log("Tokens exchanged successfully. Tokens present:", !!tokens.access_token);
      
      // Explicitly set session
      (req.session as any).tokens = tokens;
      (req.session as any).createdAt = Date.now();

      res.setHeader('Content-Type', 'text/html');
      res.send(`
        <html>
          <body style="font-family: -apple-system, sans-serif; text-align: center; padding-top: 100px; background: #f3f4f6;">
            <div style="background: white; max-width: 400px; margin: 0 auto; padding: 40px; border-radius: 24px; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1);">
              <h2 style="color: #2563eb; margin-bottom: 16px;">Success!</h2>
              <p style="color: #4b5563;">You are now connected to Google Drive.</p>
              <p style="color: #9ca3af; font-size: 14px;">This window will close automatically...</p>
              <script>
                try {
                  if (window.opener) {
                    console.log("Informing opener...");
                    window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS' }, '*');
                    setTimeout(() => window.close(), 1500);
                  } else {
                    console.log("No opener found, redirecting home");
                    window.location.href = '/';
                  }
                } catch (e) {
                  console.error("Postmessage error:", e);
                  window.location.href = '/';
                }
              </script>
            </div>
          </body>
        </html>
      `);
    } catch (error: any) {
      console.error("Error exchanging code:", error.message);
      res.status(500).send("Authentication failed. " + error.message);
    }
  });

  app.get("/api/auth/status", (req, res) => {
    const tokens = (req.session as any)?.tokens;
    console.log("Checking auth status. Session tokens present:", !!tokens?.access_token);
    
    if (tokens && tokens.access_token) {
      res.json({ authenticated: true });
    } else {
      res.json({ 
        authenticated: false, 
        reason: tokens ? "Tokens invalid" : "No session",
        debugHost: req.get('host'),
        debugEnv: process.env.APP_URL
      });
    }
  });

  app.post("/api/auth/logout", (req, res) => {
    req.session = null;
    res.json({ success: true });
  });

  // --- Drive Proxy Routes ---

  const getAccessToken = (req: express.Request) => {
    return (req.session as any)?.tokens?.access_token;
  };

  app.get("/api/drive/folders", async (req, res) => {
    const token = getAccessToken(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    try {
      const response = await axios.get('https://www.googleapis.com/drive/v3/files', {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
          fields: 'files(id, name)',
          pageSize: 50,
        },
      });
      res.json(response.data.files);
    } catch (error) {
      console.error("List folders failed:", error);
      res.status(500).json({ error: "Failed to list folders" });
    }
  });

  app.get("/api/drive/photos/:folderId", async (req, res) => {
    const token = getAccessToken(req);
    const { folderId } = req.params;
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    try {
      const response = await axios.get('https://www.googleapis.com/drive/v3/files', {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          q: `'${folderId}' in parents and mimeType contains 'image/' and trashed = false`,
          fields: 'files(id, name, mimeType, thumbnailLink, webContentLink)',
          pageSize: 100,
        },
      });
      res.json(response.data.files);
    } catch (error) {
      console.error("List photos failed:", error);
      res.status(500).json({ error: "Failed to list photos" });
    }
  });

  app.get("/api/drive/folder-meta/:folderId", async (req, res) => {
    const token = getAccessToken(req);
    const { folderId } = req.params;
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    try {
      const response = await axios.get(`https://www.googleapis.com/drive/v3/files/${folderId}`, {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          fields: 'id, name, mimeType',
        },
      });
      
      if (response.data.mimeType !== 'application/vnd.google-apps.folder') {
        return res.status(400).json({ error: "Provided link is not a folder." });
      }
      
      res.json(response.data);
    } catch (error) {
      console.error("Get folder meta failed:", error);
      res.status(500).json({ error: "Failed to access folder. Make sure the link is correct and accessible." });
    }
  });

  // --- Matching Engine ---

  app.post("/api/match", async (req, res) => {
    const token = getAccessToken(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    const { referenceBase64, candidateIds } = req.body;
    if (!referenceBase64 || !candidateIds) return res.status(400).json({ error: "Missing data" });

    try {
      // 1. Fetch images from Drive in parallel
      const candidateData = await Promise.all(
        candidateIds.map(async (id: string) => {
          const imgRes = await axios.get(`https://www.googleapis.com/drive/v3/files/${id}`, {
            headers: { Authorization: `Bearer ${token}` },
            params: { alt: 'media' },
            responseType: 'arraybuffer',
          });
          return {
            id,
            base64: Buffer.from(imgRes.data, 'binary').toString('base64')
          };
        })
      );

      // 2. Call Gemini for matching
      const response = await genAI.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [
          { text: "I am providing a reference photo of a person and several candidate photos. Identify which candidates feature the EXACT same person as in the reference photo. Output results as a JSON array of {fileId: string, isMatch: boolean, confidence: number}." },
          { inlineData: { mimeType: "image/jpeg", data: referenceBase64 } },
          ...candidateData.map((c, i) => ({
            text: `Candidate ${i} (ID: ${c.id}):`,
            inlineData: { mimeType: "image/jpeg", data: c.base64 }
          }))
        ]
      });
      
      const textResponse = response.text || "";
      
      // Clean potential markdown code blocks
      const jsonStr = textResponse.replace(/```json|```/g, "").trim();
      res.json(JSON.parse(jsonStr));

    } catch (error) {
      console.error("Matching failed:", error);
      res.status(500).json({ error: "Matching engine failed" });
    }
  });

  // Vite middleware
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
});
