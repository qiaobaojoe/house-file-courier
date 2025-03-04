const express = require('express');
const fileUpload = require('express-fileupload');
const cors = require('cors');
const path = require('path');
const { Server } = require('socket.io');
const http = require('http');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 创建上传文件目录
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

// 中间件配置
app.use(cors());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));
app.use(fileUpload({
    createParentPath: true,
    useTempFiles: true,
    tempFileDir: '/tmp/'
}));

// 创建分片上传临时目录
const chunksDir = path.join(__dirname, 'chunks');
if (!fs.existsSync(chunksDir)) {
    fs.mkdirSync(chunksDir);
}

// 获取上传进度
app.get('/api/upload/progress/:identifier', (req, res) => {
    const identifier = req.params.identifier;
    const progressPath = path.join(chunksDir, `${identifier}.json`);
    
    if (fs.existsSync(progressPath)) {
        const progress = JSON.parse(fs.readFileSync(progressPath));
        res.json(progress);
    } else {
        res.json({ uploadedChunks: [] });
    }
});

// 分片上传
app.post('/api/upload/chunk', (req, res) => {
    if (!req.files || Object.keys(req.files).length === 0) {
        return res.status(400).json({ error: '未选择文件' });
    }

    const { chunkNumber, totalChunks, identifier, filename } = req.body;
    const chunk = req.files.chunk;
    const chunkDir = path.join(chunksDir, identifier);

    // 创建文件标识符目录
    if (!fs.existsSync(chunkDir)) {
        fs.mkdirSync(chunkDir);
    }

    // 保存分片
    const chunkPath = path.join(chunkDir, `${chunkNumber}`);
    chunk.mv(chunkPath, async (err) => {
        if (err) {
            return res.status(500).json({ error: '分片上传失败' });
        }

        // 更新上传进度
        const progressPath = path.join(chunksDir, `${identifier}.json`);
        let progress = { uploadedChunks: [] };
        if (fs.existsSync(progressPath)) {
            progress = JSON.parse(fs.readFileSync(progressPath));
        }
        if (!progress.uploadedChunks.includes(parseInt(chunkNumber))) {
            progress.uploadedChunks.push(parseInt(chunkNumber));
            fs.writeFileSync(progressPath, JSON.stringify(progress));
        }

        // 检查是否所有分片都已上传
        if (progress.uploadedChunks.length === parseInt(totalChunks)) {
            try {
                // 合并文件
                const filePath = path.join(uploadDir, filename);
                const writeStream = fs.createWriteStream(filePath);
                
                for (let i = 1; i <= totalChunks; i++) {
                    const chunkPath = path.join(chunkDir, `${i}`);
                    const chunkBuffer = fs.readFileSync(chunkPath);
                    writeStream.write(chunkBuffer);
                }
                
                await new Promise((resolve, reject) => {
                    writeStream.on('finish', resolve);
                    writeStream.on('error', reject);
                    writeStream.end();
                });

                // 清理分片和进度文件
                fs.rmSync(chunkDir, { recursive: true });
                fs.unlinkSync(progressPath);

                // 通知客户端上传完成
                io.emit('fileUploaded', {
                    name: filename,
                    size: fs.statSync(filePath).size,
                    createTime: new Date()
                });

                res.json({ message: '文件上传完成' });
            } catch (error) {
                res.status(500).json({ error: '文件合并失败' });
            }
        } else {
            res.json({ message: '分片上传成功' });
        }
    });
});

// WebSocket连接处理
io.on('connection', (socket) => {
    console.log('用户已连接');
    
    socket.on('disconnect', () => {
        console.log('用户已断开连接');
    });
});

// 获取文件列表
app.get('/api/files', (req, res) => {
    fs.readdir(uploadDir, (err, files) => {
        if (err) {
            return res.status(500).json({ error: '无法读取文件列表' });
        }
        
        const fileList = files.map(file => {
            const stats = fs.statSync(path.join(uploadDir, file));
            return {
                name: file,
                size: stats.size,
                createTime: stats.birthtime
            };
        });
        
        res.json(fileList);
    });
});

// 文件上传处理
app.post('/api/upload', (req, res) => {
    if (!req.files || Object.keys(req.files).length === 0) {
        return res.status(400).json({ error: '未选择文件' });
    }

    const file = req.files.file;
    const filePath = path.join(uploadDir, file.name);

    file.mv(filePath, (err) => {
        if (err) {
            return res.status(500).json({ error: '文件上传失败' });
        }

        io.emit('fileUploaded', {
            name: file.name,
            size: file.size,
            createTime: new Date()
        });

        res.json({ message: '文件上传成功' });
    });
});

// 文件下载处理
app.get('/api/download/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(uploadDir, filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: '文件不存在' });
    }

    res.download(filePath);
});

// 删除文件
app.delete('/api/files/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(uploadDir, filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: '文件不存在' });
    }

    fs.unlink(filePath, (err) => {
        if (err) {
            return res.status(500).json({ error: '文件删除失败' });
        }

        io.emit('fileDeleted', { name: filename });
        res.json({ message: '文件删除成功' });
    });
});

const PORT = process.env.PORT || 3000;

// 获取本地IP地址
const os = require('os');
const networkInterfaces = os.networkInterfaces();
let localIP = 'localhost';

// 查找非内部的IPv4地址
for (const ifname of Object.keys(networkInterfaces)) {
    // 优先选择无线网卡或以太网卡
    if (ifname.toLowerCase().includes('en') || ifname.toLowerCase().includes('eth') || ifname.toLowerCase().includes('wi-fi')) {
        for (const iface of networkInterfaces[ifname]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                localIP = iface.address;
                break;
            }
        }
        if (localIP !== 'localhost') break;
    }
}

// 如果没有找到优先网卡，遍历所有网卡
if (localIP === 'localhost') {
    for (const ifname of Object.keys(networkInterfaces)) {
        for (const iface of networkInterfaces[ifname]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                localIP = iface.address;
                break;
            }
        }
        if (localIP !== 'localhost') break;
    }
}

server.listen(PORT, () => {
    console.log(`服务器运行在:
- 本地访问: http://localhost:${PORT}
- 局域网访问: http://${localIP}:${PORT}`)
});