import express from "express";
import exphbs from "express-handlebars";
import {home, device} from "./routes/index.js"
import dotenv from "dotenv"
import http from "http";
import { Server } from "socket.io";
import qrcode from "qrcode";
import wa from "whatsapp-web.js";
import cors from "cors"
import bodyParser from "body-parser"
import fs from "fs"
import phoneNumberFormatter from "./app/Helpers/Formatter.js"

dotenv.config();

const app = express();
// var corsOptions = {
//   origin: 'http://example.com',
//   optionsSuccessStatus: 200 // some legacy browsers (IE11, various SmartTVs) choke on 204
// }

const server = http.createServer(app);
const io = new Server(server, { 
    cors: {
        origin: "http://127.0.0.1:8000"
    }
});

// Parsing application/json
// app.use(express.json()) 
app.use(bodyParser.json())

// Parsing application/x-www-form-urlencoded
// app.use(express.urlencoded({ extended: true })) 
app.use(bodyParser.urlencoded({extended: false}))

// Static files
app.use(express.static('public'))

// Templating Engine
app.engine('hbs', exphbs.engine({extname: '.hbs'}))
app.set('view engine', 'hbs')
app.set('views', './views')

//WhatsApp Web 
const { Client, LocalAuth, Message } = wa;

//Crate Session
const sessions = [];
const SESSIONS_FILE = './whatsapp-sessions.json';

const createSessionsFileIfNotExists = function() {
  if (!fs.existsSync(SESSIONS_FILE)) {
    try {
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify([]));
      console.log('Sessions file created successfully.');
    } catch(err) {
      console.log('Failed to create sessions file: ', err);
    }
  }
}

createSessionsFileIfNotExists();

const setSessionsFile = function(sessions) {
  fs.writeFile(SESSIONS_FILE, JSON.stringify(sessions), function(err) {
    if (err) {
      console.log(err);
    }
  });
}

const getSessionsFile = function() {
  return JSON.parse(fs.readFileSync(SESSIONS_FILE));
}

// Create Session
const createSession = (id, desc) => {
    const client = new Client({
        authStrategy: new LocalAuth({ clientId: id }),
        puppeteer: { 
            headless: true,
            args: [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-dev-shm-usage',
              '--disable-accelerated-2d-canvas',
              '--no-first-run',
              '--no-zygote',
              '--single-process', // <- this one doesn't works in Windows
              '--disable-gpu'
            ]
        },
        restartOnAuthFail: true
    });

    client.initialize();

    client.on('qr', (qr) => {
        console.log('QR RECEIVED', qr);
        qrcode.toDataURL(qr, (err, url) => {
            io.emit('qr', url)
            io.emit('message', 'QR Received, scan please...')
        });
    });

    client.on('authenticated', (session) => {    
        // Save the session object however you prefer.
        // Convert it to json, save it to a file, store it in a database...
        io.emit('authenticated', 'WhatsApp has been authenticated')
        io.emit('message', 'WhatsApp has been authenticated')
    });

    client.on('ready', () => {
        io.emit('ready', 'Connected')
        io.emit('message', 'WhatsApp is ready!')
        console.log('WhatsApp is ready!')
        
        //Menambahkan Sessions ke File
        const savedSessions = getSessionsFile();
        const sessionIndex = savedSessions.findIndex(sess => sess.id == id);
        savedSessions[sessionIndex].ready = true;
        setSessionsFile(savedSessions);  
    });

    client.on('auth_failure', function() {
        io.emit('message', 'Auth failure, restarting...');
    });

    client.on('disconnected', (reason) => {    
        // Save the session object however you prefer.
        io.emit('message', 'WhatsApp disconnected!')
        console.log('WhatsApp disconnected!')
        client.destroy()
        client.initialize();

         // Menghapus pada file sessions
        const savedSessions = getSessionsFile();
        const sessionIndex = savedSessions.findIndex(sess => sess.id == id);
        savedSessions.splice(sessionIndex, 1);
        setSessionsFile(savedSessions);

        io.emit('remove-session', id);
        console.log('Session' + id + ' sudah dihapus')
    });

    client.on('message', message => {
        if(message.body === '!ping') {
            message.reply('pong');
        }
    });
    
    // Tambahkan client ke sessions
    sessions.push({
        id: id,
        description: desc,
        client: client
    });

    // Menambahkan session ke file
    const savedSessions = getSessionsFile();
    const sessionIndex = savedSessions.findIndex(sess => sess.id == id);

    if (sessionIndex == -1) {
        savedSessions.push({
            id: id,
            description: desc,
            ready: false,
        });
        setSessionsFile(savedSessions);
    }
}

const init = function(socket) {
  const savedSessions = getSessionsFile();

  if (savedSessions.length > 0) {
    if (socket) {
      /**
       * At the first time of running (e.g. restarting the server), our client is not ready yet!
       * It will need several time to authenticating.
       * 
       * So to make people not confused for the 'ready' status
       * We need to make it as FALSE for this condition
       */
      savedSessions.forEach((e, i, arr) => {
        arr[i].ready = false;
      });

      socket.emit('init', savedSessions);
    } else {
      savedSessions.forEach(sess => {
        createSession(sess.id, sess.description);
      });
    }
  }
}

init();

// Socket IO
io.on('connection', (socket) => {
    // init(socket); 
  
    // socket.on('create-session', (data) => {
    //   console.log('Create session: ' + data.id);
    //   createSession(data.id, data.desc);
    // });
    console.log('a user connected');
  });

//Router
app.use(home);
app.use(device);

// Send message
app.post('/send-message', cors(), async (req, res) => {
  console.log(req.body);
  // console.log(sessions);

  const sender = req.body.device;
  const number = phoneNumberFormatter(req.body.receiver);
  const message = req.body.message;

  // console.log(number);

  const client = sessions.find(sess => sess.id == sender)?.client;

  // Make sure the sender is exists & ready
  if (!client) {
    return res.status(422).json({
      status: false,
      message: `The sender: ${sender} is not found!`
    })
  }

  /**
   * Check if the number is already registered
   * Copied from app.js
   * 
   * Please check app.js for more validations example
   * You can add the same here!
   */

  // const checkRegisteredNumber = async function(number) {
  //   const isRegistered = await client.isRegisteredUser(number);
  //   return isRegistered;
  // }

  // const isRegisteredNumber = await checkRegisteredNumber(number);

  // if (!isRegisteredNumber) {
  //   return res.status(422).json({
  //     status: false,
  //     message: 'The number is not registered'
  //   });
  // }

  client.sendMessage(number, message).then(response => {
    res.status(200).json({
      status: true,
      response: response
    });
  }).catch(err => {
    res.status(500).json({
      status: false,
      response: err
    });
  });

});

app.get('/get-info', cors(), async(req, res) => {
  const message = new Message();
  const status = await message.getInfo('3EB021A2D7887C19AD88');
  console.log(status)
})

const port = process.env.PORT || 3000;
server.listen(port, () => console.log('Server is running...'))
