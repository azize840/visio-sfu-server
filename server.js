const mediasoup = require('mediasoup');
const express = require('express');
const cors = require('cors');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');

const app = express();

// CORS étendu pour mobile et ngrok
app.use(cors({
    origin: [
        "https://pandurate-squatly-hae.ngrok-free.dev",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        /\.ngrok-free\.dev$/,
        /\.fly\.dev$/,
        /\.onrender\.com$/
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
}));

app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({
    server,
    path: '/ws',
    // Autoriser toutes les origines pour WebSocket
    verifyClient: (info, callback) => {
        callback(true);
    }
});

// Configuration Mediasoup optimisée
const mediaCodecs = [
    {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2,
        parameters: {
            minptime: 10,
            useinbandfec: 1
        }
    },
    {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters: {
            'x-google-start-bitrate': 1000,
            'x-google-max-bitrate': 3000,
            'x-google-min-bitrate': 400
        }
    },
    {
        kind: 'video',
        mimeType: 'video/H264',
        clockRate: 90000,
        parameters: {
            'packetization-mode': 1,
            'profile-level-id': '42e01f',
            'level-asymmetry-allowed': 1
        }
    }
];

let worker;
let rooms = new Map();

async function createWorker() {
    worker = await mediasoup.createWorker({
        logLevel: 'warn',
        rtcMinPort: 40000,
        rtcMaxPort: 50000,
        // Configuration pour environnement cloud
        dtlsCertificateFile: process.env.DTLS_CERT_FILE,
        dtlsPrivateKeyFile: process.env.DTLS_KEY_FILE
    });

    console.log('✅ Worker Mediasoup créé sur Fly.io');

    worker.on('died', () => {
        console.error('❌ Mediasoup worker died');
        process.exit(1);
    });

    return worker;
}

// Health check amélioré
app.get('/health', (req, res) => {
    const roomStats = Array.from(rooms.values()).map(room => ({
        participants: room.participants.size,
        createdAt: room.createdAt
    }));

    res.json({
        status: 'ok',
        server: 'visiocampus-mediasoup',
        provider: 'Fly.io Free Tier',
        hours_free: 'jusqu\'à 3 VMs gratuites',
        cost: '0€',
        timestamp: new Date().toISOString(),
        rooms_count: rooms.size,
        room_stats: roomStats,
        worker: worker ? 'active' : 'inactive'
    });
});

// Route pour infos réseau
app.get('/network-info', (req, res) => {
    res.json({
        server_url: process.env.FLY_APP_NAME ?
            `https://${process.env.FLY_APP_NAME}.fly.dev` :
            'http://localhost:3001',
        websocket_url: process.env.FLY_APP_NAME ?
            `wss://${process.env.FLY_APP_NAME}.fly.dev/ws` :
            'ws://localhost:3001/ws',
        external_url: process.env.FLY_APP_NAME,
        timestamp: new Date().toISOString()
    });
});

// Créer une room SFU
app.post('/rooms', async (req, res) => {
    try {
        const { room_id, max_participants = 50 } = req.body;

        if (!room_id) {
            return res.status(400).json({
                success: false,
                error: 'room_id requis'
            });
        }

        if (rooms.has(room_id)) {
            const room = rooms.get(room_id);
            return res.json({
                success: true,
                room_id,
                exists: true,
                participants_count: room.participants.size,
                max_participants: room.maxParticipants
            });
        }

        const router = await worker.createRouter({ mediaCodecs });

        rooms.set(room_id, {
            router,
            participants: new Map(),
            createdAt: new Date(),
            maxParticipants: max_participants
        });

        console.log(`✅ Room SFU créée: ${room_id} (max: ${max_participants} participants)`);

        res.json({
            success: true,
            room_id,
            exists: false,
            max_participants: max_participants,
            rtp_capabilities: router.rtpCapabilities
        });

    } catch (error) {
        console.error('❌ Erreur création room:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Générer token participant
app.post('/tokens', async (req, res) => {
    try {
        const { room_id, participant_id } = req.body;

        if (!room_id || !participant_id) {
            return res.status(400).json({
                success: false,
                error: 'room_id et participant_id requis'
            });
        }

        if (!rooms.has(room_id)) {
            return res.status(404).json({
                success: false,
                error: 'Room non trouvée'
            });
        }

        const room = rooms.get(room_id);

        // Vérifier si la room n'est pas pleine
        if (room.participants.size >= room.maxParticipants) {
            return res.status(429).json({
                success: false,
                error: 'Room pleine'
            });
        }

        const rtpCapabilities = room.router.rtpCapabilities;

        // URL Fly.io avec WebSocket sécurisé
        const flyUrl = process.env.FLY_APP_NAME ?
            `https://${process.env.FLY_APP_NAME}.fly.dev` :
            'http://localhost:3001';

        const websocketUrl = process.env.FLY_APP_NAME ?
            `wss://${process.env.FLY_APP_NAME}.fly.dev/ws` :
            'ws://localhost:3001/ws';

        res.json({
            success: true,
            room_id,
            participant_id,
            rtp_capabilities: rtpCapabilities,
            server_url: websocketUrl,
            ice_servers: [
                {
                    urls: [
                        'stun:stun.l.google.com:19302',
                        'stun:stun1.l.google.com:19302',
                        'stun:stun2.l.google.com:19302'
                    ]
                }
            ],
            provider: 'Fly.io',
            max_participants: room.maxParticipants,
            current_participants: room.participants.size
        });

    } catch (error) {
        console.error('❌ Erreur génération token:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Obtenir les stats d'une room
app.get('/rooms/:room_id', (req, res) => {
    try {
        const { room_id } = req.params;

        if (!rooms.has(room_id)) {
            return res.status(404).json({
                success: false,
                error: 'Room non trouvée'
            });
        }

        const room = rooms.get(room_id);
        const participants = Array.from(room.participants.values()).map(p => ({
            id: p.id,
            joinedAt: p.joinedAt,
            transports: p.transports ? p.transports.size : 0
        }));

        res.json({
            success: true,
            room_id,
            created_at: room.createdAt,
            participants_count: room.participants.size,
            max_participants: room.maxParticipants,
            participants: participants
        });

    } catch (error) {
        console.error('❌ Erreur récupération room:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Gestion des WebSockets améliorée
wss.on('connection', (ws, request) => {
    const clientIp = request.headers['x-forwarded-for'] ||
                    request.socket.remoteAddress;

    console.log(`✅ Nouvelle connexion WebSocket depuis: ${clientIp}`);
    console.log(`📡 Headers:`, request.headers);

    // Envoyer un message de bienvenue
    ws.send(JSON.stringify({
        action: 'connected',
        message: 'Connexion SFU établie',
        server: 'Fly.io Mediasoup',
        timestamp: new Date().toISOString()
    }));

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            console.log('📨 Message WebSocket:', data.action);

            // Répondre systématiquement
            ws.send(JSON.stringify({
                action: 'ack',
                original_action: data.action,
                received: true,
                timestamp: new Date().toISOString()
            }));

        } catch (error) {
            console.error('❌ Erreur WebSocket:', error);
            ws.send(JSON.stringify({
                action: 'error',
                error: error.message
            }));
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`🔌 Connexion WebSocket fermée: ${code} - ${reason}`);
    });

    ws.on('error', (error) => {
        console.error('❌ Erreur WebSocket:', error);
    });
});

// Nettoyage automatique des rooms inactives
setInterval(() => {
    const now = new Date();
    const inactiveTime = 30 * 60 * 1000; // 30 minutes

    for (const [roomId, room] of rooms.entries()) {
        if (now - room.createdAt > inactiveTime && room.participants.size === 0) {
            rooms.delete(roomId);
            console.log(`🧹 Room nettoyée: ${roomId}`);
        }
    }
}, 5 * 60 * 1000); // Toutes les 5 minutes

// Démarrer le serveur
async function startServer() {
    try {
        await createWorker();

        const PORT = process.env.PORT || 3001;
        const HOST = process.env.FLY_APP_NAME ? '0.0.0.0' : 'localhost';

        server.listen(PORT, HOST, () => {
            console.log('='.repeat(60));
            console.log('🚀 VISIOCAMPUS MEDIASOUP - FLY.IO');
            console.log('='.repeat(60));
            console.log(`📡 Serveur: ${HOST}:${PORT}`);
            console.log(`🔌 WebSockets: wss://${process.env.FLY_APP_NAME || 'localhost'}.fly.dev/ws`);
            console.log(`🌍 CORS: Activé pour mobile et ngrok`);
            console.log(`💰 Free Tier: 3 VMs partagées gratuites`);
            console.log(`💳 Carte crédit: Requise mais non débitée`);
            console.log('='.repeat(60));

            if (!process.env.FLY_APP_NAME) {
                console.log('⚠️  Mode développement local');
                console.log(`🔗 URL: http://localhost:${PORT}`);
                console.log(`🔗 WebSocket: ws://localhost:${PORT}/ws`);
            }
        });
    } catch (error) {
        console.error('❌ Erreur démarrage:', error);
        process.exit(1);
    }
}

// Gestion propre de l'arrêt
process.on('SIGINT', async () => {
    console.log('\n🛑 Arrêt du serveur Mediasoup...');

    if (worker) {
        worker.close();
    }

    server.close(() => {
        console.log('✅ Serveur arrêté proprement');
        process.exit(0);
    });
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Arrêt du serveur (SIGTERM)...');

    if (worker) {
        worker.close();
    }

    server.close(() => {
        console.log('✅ Serveur arrêté proprement');
        process.exit(0);
    });
});

startServer();
