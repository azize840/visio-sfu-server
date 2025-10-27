const mediasoup = require('mediasoup');
const express = require('express');
const cors = require('cors');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');

const app = express();
app.use(cors());
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Configuration Mediasoup
const mediaCodecs = [
    {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2
    },
    {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters: {
            'x-google-start-bitrate': 1000
        }
    }
];

let worker;
let rooms = new Map();

async function createWorker() {
    worker = await mediasoup.createWorker({
        logLevel: 'warn',
        rtcMinPort: 40000,
        rtcMaxPort: 50000
    });

    console.log('✅ Worker Mediasoup créé sur Render.com');

    worker.on('died', () => {
        console.error('❌ Mediasoup worker died');
        process.exit(1);
    });

    return worker;
}

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        server: 'visiocampus-mediasoup',
        provider: 'Render.com Free Tier',
        hours_free: '750/mois',
        cost: '0€',
        timestamp: new Date().toISOString(),
        rooms_count: rooms.size
    });
});

// Créer une room SFU
app.post('/rooms', async (req, res) => {
    try {
        const { room_id, max_participants = 50 } = req.body;

        if (rooms.has(room_id)) {
            return res.json({
                success: true,
                room_id,
                exists: true
            });
        }

        const router = await worker.createRouter({ mediaCodecs });

        rooms.set(room_id, {
            router,
            participants: new Map(),
            createdAt: new Date(),
            maxParticipants: max_participants
        });

        console.log(`✅ Room SFU créée: ${room_id}`);

        res.json({
            success: true,
            room_id,
            exists: false,
            max_participants: max_participants
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

        if (!rooms.has(room_id)) {
            return res.status(404).json({
                success: false,
                error: 'Room non trouvée'
            });
        }

        const room = rooms.get(room_id);
        const rtpCapabilities = room.router.rtpCapabilities;

        // URL Render.com avec WebSocket
        const renderUrl = process.env.RENDER_EXTERNAL_URL ||
                         `https://visio-sfu-server.onrender.com`;

        res.json({
            success: true,
            room_id,
            participant_id,
            rtp_capabilities: rtpCapabilities,
            server_url: `${renderUrl.replace('https', 'wss')}/ws`,
            ice_servers: [
                {
                    urls: [
                        'stun:stun.l.google.com:19302',
                        'stun:stun1.l.google.com:19302',
                        'stun:stun2.l.google.com:19302'
                    ]
                }
            ],
            provider: 'Render.com'
        });

    } catch (error) {
        console.error('❌ Erreur génération token:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Gestion des WebSockets
wss.on('connection', (ws, request) => {
    console.log('✅ Nouvelle connexion WebSocket Render');

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            console.log('📨 Message WebSocket:', data.action);

            // Répondre pour confirmer la connexion
            ws.send(JSON.stringify({
                action: 'connected',
                message: 'WebSocket SFU ready'
            }));

        } catch (error) {
            console.error('❌ Erreur WebSocket:', error);
        }
    });

    ws.on('close', () => {
        console.log('🔌 Connexion WebSocket fermée');
    });
});

// Nettoyage automatique
setInterval(() => {
    const now = new Date();
    const inactiveTime = 30 * 60 * 1000; // 30 minutes

    for (const [roomId, room] of rooms.entries()) {
        if (now - room.createdAt > inactiveTime && room.participants.size === 0) {
            rooms.delete(roomId);
            console.log(`🧹 Room nettoyée: ${roomId}`);
        }
    }
}, 5 * 60 * 1000);

// Démarrer le serveur
async function startServer() {
    try {
        await createWorker();

        const PORT = process.env.PORT || 3001;
        server.listen(PORT, () => {
            console.log('='.repeat(50));
            console.log('🚀 VISIOCAMPUS MEDIASOUP - RENDER.COM');
            console.log(`📡 Port: ${PORT}`);
            console.log('🔌 WebSockets: ACTIVÉS');
            console.log('💰 Free Tier: 750 heures/mois');
            console.log('💳 Carte crédit: NON REQUISE');
            console.log('='.repeat(50));
        });
    } catch (error) {
        console.error('❌ Erreur démarrage:', error);
        process.exit(1);
    }
}

startServer();
