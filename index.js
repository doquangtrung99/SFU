const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const {
    createWorker,
} = require("mediasoup");

const app = express();
app.use(cors())
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
const server = http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: "*",
        credentials: true
    }
});

const rooms = {}
const connects = {}
io.on('connection', (socket) => {

    socket.on('joinRoom', async ({ room }, callback) => {
        connects[socket.id] = room

        if (!rooms[room]) {
            rooms[room] = {}
            const mediaCodecs = [
                {
                    kind: "audio",
                    mimeType: "audio/opus",
                    clockRate: 48000,
                    channels: 2
                },
                {
                    kind: 'video',
                    mimeType: 'video/VP8',
                    clockRate: 90000,
                    parameters: {
                        'x-google-start-bitrate': 1000,
                    },
                },
            ];

            const worker = await createWorker({
                rtcMinPort:10000,
                rtcMaxPort:59999
            })
            rooms[room].worker = worker;
            rooms[room].router = await worker.createRouter({ mediaCodecs });
            // rooms[room].webRtcServer = await worker.createWebRtcServer({
            //     listenInfos :
            //     [
            //       {
            //         protocol : 'udp',
            //         ip       : '0.0.0.0',
            //         announcedIp: '127.0.0.1',
            //     },
            //       {
            //         protocol : 'tcp',
            //         ip       : '0.0.0.0',
            //         announcedIp: '127.0.0.1',
            //     }
            //     ]
            //   })
            rooms[room].transports = [];
            rooms[room].producers = [];
            rooms[room].consumers = [];
        }
        callback(rooms[room].router.rtpCapabilities)
    })

    socket.on('createWebRtcTransport', async ({ producing, sctpCapabilities, room, socketId }, callback) => {
        const transportType = producing ? 'producerTransport' : 'consumerTransport';
        // webRtcServer: rooms[room].webRtcServer,
        const transport = await rooms[room].router.createWebRtcTransport({
            listenIps: [
                {
                  ip: '18.142.128.26', // replace with relevant IP address
                  announcedIp: null,
                }
              ],
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
        });
        if (rooms[room].transports[socketId]) {
            rooms[room].transports = { ...rooms[room].transports, [socketId]: [...rooms[room].transports[socketId], { [transportType]: transport, consuming: !producing, socketId: socket.id }] };
        } else {
            rooms[room].transports = { ...rooms[room].transports, [socketId]: [{ [transportType]: transport, consuming: !producing, socketId: socket.id }] };
        }
        callback({
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
            sctpParameters: transport.sctpParameters,
        });

    })

    socket.on('getProducers', ({ room }, callback) => {
        callback(rooms[room].producers)
    })
    const findTransport = (room, consuming, transportId, socketId) => {
        const type = consuming ? 'consumerTransport' : 'producerTransport'
        const transport = rooms[room].transports[socketId].find(producer => producer.consuming === consuming && producer[type].id === transportId)
        return transport[type]
    }

    socket.on('connectWebRtcTransport', async ({ transportId, dtlsParameters, room, socketId }) => {
        const producerTransport = findTransport(room, false, transportId, socketId)
        await producerTransport.connect({ dtlsParameters })
    })

    socket.on('produce', async ({ transportId, kind, rtpParameters, appData, room, socketId }, callback) => {

        const producer = await findTransport(room, false, transportId, socketId)
            .produce({
                kind,
                rtpParameters,
                appData,
            })

        rooms[room].producers = [...rooms[room].producers, { producer, producerId: producer.id, socketId: socket.id }]
        const notFirstCreatedProducer = rooms[room].producers.length > 1
        socket.broadcast.emit('new-producer', producer.id)
        callback({ id: producer.id, notFirstCreatedProducer })
    })

    socket.on('connectConsumer', async ({ rtpCapabilities, producerServerId, consumerTransportId, socketId, room }, callback) => {
        const response = await rooms[room].router.canConsume({ producerId: producerServerId, rtpCapabilities })
        if (response) {
            const consumer = await findTransport(room, true, consumerTransportId, socketId).consume({
                producerId: producerServerId,
                paused: true,
                rtpCapabilities
            })
            consumer.on('transportclose', () => {
                console.log('transport close from consumer')
            })

            consumer.on('producerclose', () => {
                socket.emit('producerclose', producerServerId)
            })

            if (rooms[room].consumers[socketId]) {
                rooms[room].consumers = {
                    ...rooms[room].consumers,
                    [socketId]: [...rooms[room].consumers[socketId], { consumerId: consumer.id, consumer, socketId: socket.id }]
                };
            } else {
                rooms[room].consumers = {
                    ...rooms[room].consumers,
                    [socketId]: [{ consumerId: consumer.id, consumer, socketId: socket.id }]
                };
            }
            const handleResume = async () => {
                try {
                    await consumer.resume();
                    socket.removeListener('resume', handleResume);
                } catch (error) {
                    console.log('crash here', error);
                }
            }
            socket.on('resume', handleResume)
            const params = {
                id: consumer.id,
                producerId: producerServerId,
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters
            }
            callback({ params, consumerTransportId })
        }
    })

    socket.on('receive-consumer-connect', async ({ dtlsParameters, consumerTransportId, room, socketId }) => {
        const consumerTransport = findTransport(room, true, consumerTransportId, socketId)
        await consumerTransport.connect({ dtlsParameters })
    })

    socket.on('disconnect', () => {
        const room = connects[socket.id]

        if (rooms[room].consumers[socket.id]) {
            for (let consumer of rooms[room].consumers[socket.id]) {
                if (consumer.socketId === socket.id) {
                    consumer.consumer.close()
                }
            }
        }

        rooms[room].producers.forEach(({ producer, socketId }) => {
            if (socket.id === socketId) {
                producer.close()
            }
        })

        rooms[room].producers = rooms[room].producers.filter(({ socketId }) => socket.id !== socketId)

        if (rooms[room].transports[socket.id]) {
            for (let transport of rooms[room].transports[socket.id]) {
                if (transport.socketId === socket.id) {
                    const type = transport['consumerTransport'] ? 'consumerTransport' : 'producerTransport'
                    transport[type].close()
                }
            }
        }
        delete rooms[room].consumers[socket.id]
        delete rooms[room].transports[socket.id]
        delete connects[socket.id]

        console.log('rooms', rooms)
    });
});

server.listen(3000, () => {
    console.log('Server is running on http://localhost:3000');
});
