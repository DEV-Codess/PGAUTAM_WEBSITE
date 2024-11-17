const express = require('express');
const mysql = require('mysql2');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const port = 3000;

// Middleware to parse JSON bodies with increased payload size
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));
require('dotenv').config(); // Load environment variables from .env file

const connection = mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, // Use environment variable
    database: process.env.DB_NAME
});


connection.connect((err) => {
    if (err) {
        console.error('Error connecting to MySQL:', err.message);
        process.exit(1); // Exit the process if connection fails
    }
    console.log('Connected to Aiven MySQL!');
    createTables();
});

// Dummy user credentials
const users = [
    { username: 'admin', password: 'admin123', role: 'admin' },
    { username: 'user', password: 'user123', role: 'user' }
];

// Serve the login page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html')); // Default login page
});

// Login endpoint
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    console.log('Login attempt:', username); // Debugging log
    const user = users.find(u => u.username === username && u.password === password);

    if (user) {
        console.log('Login successful:', username);
        res.json({ role: user.role }); // Return the user's role
    } else {
        console.log('Login failed for:', username);
        res.status(401).json({ message: 'Invalid username or password' });
    }
});

// Upload CSV endpoint
// Upload CSV endpoint with truncation
app.post('/upload-csv/:table', (req, res) => {
    const table = req.params.table;
    const data = req.body;

    const validTables = ['ACC', 'EXP', 'MASTER1', 'MISC', 'TAXREG'];
    if (!validTables.includes(table)) {
        return res.status(400).send('Invalid table name.');
    }

    if (!Array.isArray(data) || data.length === 0) {
        return res.status(400).send('No data provided or data format is incorrect.');
    }

    // Truncate the table first
    const truncateQuery = `TRUNCATE TABLE ${table}`;
    connection.query(truncateQuery, (truncateErr) => {
        if (truncateErr) {
            console.error(`Error truncating table ${table}:`, truncateErr.message);
            return res.status(500).send('Error truncating table.');
        }

        console.log(`Table ${table} truncated successfully.`);

        // Insert new data into the table
        const insertPromises = data.map(row => {
            const columns = Object.keys(row).join(',');
            const placeholders = Object.keys(row).map(() => '?').join(',');
            const values = Object.values(row);

            const query = `
                INSERT INTO ${table} (${columns}) VALUES (${placeholders})
                ON DUPLICATE KEY UPDATE ${Object.keys(row)
                    .map(col => `${col} = VALUES(${col})`)
                    .join(', ')}
            `;

            return new Promise((resolve, reject) => {
                connection.query(query, values, err => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        });

        Promise.all(insertPromises)
            .then(() => res.send(`Data successfully uploaded to ${table}.`))
            .catch(err => {
                console.error(`Error inserting data into table ${table}:`, err.message);
                res.status(500).send('Error inserting data.');
            });
    });
});


// Fetch data for users (example: from ACC table)
app.get('/data', (req, res) => {
    connection.query('SELECT * FROM ACC', (err, results) => {
        if (err) {
            res.status(500).send('Error fetching data.');
        } else {
            res.json(results);
        }
    });
});

app.get('/client-data', (req, res) => {
    const query = `
        SELECT PARTYCODE AS ClientCode, DESCR AS ClientName, clobal as vCLOBAL
        FROM MASTER1 
        WHERE PARTYCODE LIKE 'ACAD%' AND LENGTH(PARTYCODE) = 8 order by clobal 
    `;

    connection.query(query, (err, results) => {
        if (err) {
            console.error('Error fetching client data:', err.message);
            res.status(500).send('Error fetching client data.');
        } else {
            res.json(results);
        }
    });
});


app.get('/ledger/:code', (req, res) => {
    const clientCode = req.params.code; // Get the code from the URL

    const query = `
        SELECT 
            m.DESCR AS ClientName, -- Name for the clicked code
            CONCAT_WS(', ', m.ADD1, m.ADD2, m.ADD3, m.CITY, m.DIST, m.STATE) AS Address,
            CONCAT_WS(', ', m.PHONE1, m.PHONE2) AS PhoneNumber, -- Combine phone numbers
            m.SALETAXNOG AS REF1,
            m.OPBAL AS OpeningBalance, -- Opening balance
            DATE_FORMAT(acc.INVDATE, '%d-%m-%Y') AS Date, -- Format date as DD-MM-YYYY
            acc.INVNO AS InvoiceNumber,
            acc.DBCR AS DebitCredit,
            acc.NETTOTAL AS NetTotal,
            (SELECT DESCR FROM MASTER1 WHERE PARTYCODE = acc.OTHERCODE) AS OtherCodeName -- Name of OtherCode
        FROM ACC acc
        LEFT JOIN MASTER1 m ON m.PARTYCODE = acc.PARTYCODE
        WHERE acc.PARTYCODE = ? AND acc.INVDATE >= '2020-04-01'; -- Adjust as needed based on format
    `;
    // acc.OTHERCODE AS OtherCode,
    connection.query(query, [clientCode], (err, results) => {
        if (err) {
            console.error('Error fetching ledger data:', err.message);
            res.status(500).send('Error fetching ledger data.');
        } else {
            if (results.length > 0) {
                const clientDetails = {
                    Code: clientCode,
                    Name: results[0]?.ClientName || 'N/A',
                    Address: results[0]?.Address || 'N/A',
                    PhoneNumber: results[0]?.PhoneNumber || 'N/A',
                    OpeningBalance: results[0]?.OpeningBalance || 0,
                    REF1: results[0]?.REF1 || 'N/A',
                };
                res.json({
                    clientDetails,
                    ledger: results,
                });
            } else {
                res.status(404).send('No data found for the given client code.');
            }
        }
    });
});



// Function to create tables if not exist
function createTables() {
    const tables = [
        {
            name: 'ACC',
            schema: `
                ID INT AUTO_INCREMENT PRIMARY KEY,
                SELE_REC VARCHAR(255),
                SLIP_NO VARCHAR(255),
                PRIFIX VARCHAR(255),
                INVNO VARCHAR(255),
                INVDATE DATE,
                PARTYCODE VARCHAR(255),
                NETTOTAL DECIMAL(10, 2),
                DBCR VARCHAR(255),
                OTHERCODE VARCHAR(255),
                ORDERDCNO VARCHAR(255),
                ORDERDCDT DATE,
                MODPAY VARCHAR(255),
                REFBLNO VARCHAR(255),
                REFBLDT DATE,
                REMARKS TEXT,
                CODE VARCHAR(255),
                REMARKS1 TEXT,
                REMARKS2 TEXT,
                REMARKS3 TEXT,
                BALAMT DECIMAL(10, 2),
                SHARE DECIMAL(10, 2),
                MODPAYB VARCHAR(255),
                RET1 DECIMAL(10, 2),
                SAMT DECIMAL(10, 2),
                SRT VARCHAR(255),
                EDC DECIMAL(10, 2),
                BLADJ DECIMAL(10, 2),
                CR_NO VARCHAR(255),
                CRNNO VARCHAR(255),
                CRNRS DECIMAL(10, 2),
                TD_NO VARCHAR(255),
                TDSNO VARCHAR(255),
                TDSRS DECIMAL(10, 2),
                IND VARCHAR(255),
                TAXPER DECIMAL(5, 2),
                SUBTOTAL DECIMAL(10, 2),
                MODSUB VARCHAR(255),
                DESIGN VARCHAR(255),
                MODDES VARCHAR(255),
                ADVTTAX DECIMAL(10, 2),
                ADVTCESS DECIMAL(10, 2),
                DESTAX DECIMAL(10, 2),
                DESCESS DECIMAL(10, 2),
                ADVTHCESS DECIMAL(10, 2),
                DESHCESS DECIMAL(10, 2),
                ROUND DECIMAL(10, 2),
                TMPCRN VARCHAR(255),
                TMPTDS VARCHAR(255),
                TMPADJ DECIMAL(10, 2),
                ISGST DECIMAL(10, 2),
                ICGST DECIMAL(10, 2),
                IIGST DECIMAL(10, 2),
                DSGST DECIMAL(10, 2),
                DCGST DECIMAL(10, 2),
                DIGST DECIMAL(10, 2),
                DISCOUNT DECIMAL(10, 2),
                SLB VARCHAR(255),
                PRNO VARCHAR(255),
                RATEG DECIMAL(10, 2),
                SRTYPE VARCHAR(255),
                GSTYPE VARCHAR(255),
                GSTFILE VARCHAR(255),
                TOTCB DECIMAL(10, 2),
                TOTCR DECIMAL(10, 2),
                TOTTDS DECIMAL(10, 2)
            `
        },
        {
            name: 'EXP',
            schema: `
                ID INT AUTO_INCREMENT PRIMARY KEY,
                INVNO VARCHAR(255),
                PARTYCODE VARCHAR(255),
                DUE INT,
                COMMISION DECIMAL(10, 2),
                BOX_CHRG DECIMAL(10, 2),
                NEWS_PAPER DECIMAL(10, 2),
                DIS_PER DECIMAL(10, 2),
                DISCOUNT DECIMAL(10, 2),
                SUBTOTAL DECIMAL(10, 2),
                NETTOTAL DECIMAL(10, 2),
                RELEASE_NO VARCHAR(255),
                RELEASE_DT DATE,
                CLIENT VARCHAR(255),
                TYPE_ADV VARCHAR(255),
                PUB_MONTH VARCHAR(255),
                PUB_DATE DATE,
                EXT_CHARGE DECIMAL(10, 2),
                ROUND DECIMAL(10, 2),
                PART_AMT DECIMAL(10, 2),
                PART_PER DECIMAL(5, 2),
                SUR_PER DECIMAL(5, 2),
                SUR_CHRG DECIMAL(10, 2),
                POSITIVE DECIMAL(10, 2),
                CAPTION TEXT,
                THROUGH TEXT,
                POSI_HEAD VARCHAR(255),
                DESI_HEAD VARCHAR(255),
                SERV_TAX DECIMAL(10, 2),
                NAME VARCHAR(255),
                ADD1 TEXT,
                ADD2 TEXT,
                ADD3 TEXT,
                SALESMAN VARCHAR(255),
                DIFF VARCHAR(255),
                AAA VARCHAR(255)
            `
        },
        {
            name: 'MASTER1',
            schema: `
                ID INT AUTO_INCREMENT PRIMARY KEY,
                SELE_REC VARCHAR(255),
                PARTYCODE VARCHAR(255),
                DESCR TEXT,
                P_NAME VARCHAR(255),
                ADD1 TEXT,
                ADD2 TEXT,
                ADD3 TEXT,
                CITY VARCHAR(255),
                DIST VARCHAR(255),
                STATE VARCHAR(255),
                ZONE VARCHAR(255),
                PINCODE VARCHAR(20),
                TELEXE VARCHAR(255),
                FAX VARCHAR(255),
                TELEGRAM VARCHAR(255),
                PHONE1 VARCHAR(255),
                PHONE2 VARCHAR(255),
                SALETAXNOC VARCHAR(255),
                SALETAXNOG VARCHAR(255),
                OPBAL DECIMAL(10, 2),
                TOTDR DECIMAL(10, 2),
                TOTCR DECIMAL(10, 2),
                CLOBAL DECIMAL(10, 2),
                TMPDR DECIMAL(10, 2),
                TMPCR DECIMAL(10, 2),
                TMPBAL DECIMAL(10, 2),
                CODE VARCHAR(255),
                TRADING VARCHAR(255),
                REFFBY VARCHAR(255),
                CONNECT VARCHAR(255),
                CONNEYN VARCHAR(255),
                CONMAIN VARCHAR(255),
                SGST VARCHAR(255),
                GST VARCHAR(255)
            `
        },
        {
            name: 'MISC',
            schema: `
                ID INT AUTO_INCREMENT PRIMARY KEY,
                INVNO VARCHAR(255),
                INVDATE DATE,
                PARTYCODE VARCHAR(255),
                SRNO INT,
                BILLNO VARCHAR(255),
                BILLDATE DATE,
                PRODCODE VARCHAR(255),
                DESCRIPTIO TEXT,
                DESC1 TEXT,
                POSITION VARCHAR(255),
                INSERT_DT DATE,
                SIZE1 DECIMAL(10, 2),
                SIZE2 DECIMAL(10, 2),
                SIZE_HEAD VARCHAR(255),
                TOT_SPACE DECIMAL(10, 2),
                RATE_DIFF DECIMAL(10, 2),
                TRAD_DISC DECIMAL(10, 2),
                NETPRICE DECIMAL(10, 2),
                AMOUNT DECIMAL(10, 2),
                SUBTOTAL DECIMAL(10, 2),
                POSTFLG BOOLEAN,
                SERV_PER DECIMAL(5, 2),
                RSIZE1 DECIMAL(10, 2),
                RSIZE2 DECIMAL(10, 2),
                RRATE DECIMAL(10, 2),
                AAA VARCHAR(255),
                RNO VARCHAR(255)
            `
        },
        {
            name: 'TAXREG',
            schema: `
                ID INT AUTO_INCREMENT PRIMARY KEY,
                NO VARCHAR(255),
                INVDATE DATE,
                INVNO VARCHAR(255),
                PARTYCODE VARCHAR(255),
                NETTOTAL DECIMAL(10, 2),
                RINVDATE DATE,
                RINVNO VARCHAR(255),
                RINVAMT DECIMAL(10, 2),
                CINVDATE DATE,
                CINVNO VARCHAR(255),
                CINVAMT DECIMAL(10, 2),
                TINVDATE DATE,
                TINVNO VARCHAR(255),
                TINVAMT DECIMAL(10, 2),
                TAXPER DECIMAL(5, 2),
                DESIGN VARCHAR(255),
                DESTAX DECIMAL(10, 2),
                DESCESS DECIMAL(10, 2),
                DESHCESS DECIMAL(10, 2),
                ADVTTAX DECIMAL(10, 2),
                ADVTCESS DECIMAL(10, 2),
                ADVTHCESS DECIMAL(10, 2),
                RTAXAMT DECIMAL(10, 2),
                SUBTOTAL DECIMAL(10, 2),
                PNAME VARCHAR(255)
            `
        }
    ];

    tables.forEach((table) => {
        const query = `CREATE TABLE IF NOT EXISTS ${table.name} (${table.schema})`;
        connection.query(query, (err) => {
            if (err) {
                console.error(`Error creating table ${table.name}:`, err.message);
            } else {
                console.log(`Table ${table.name} is ready.`);
            }
        });
    });
}


// Catch-All for Undefined Routes
app.use((req, res) => {
  res.status(404).send('Page Not Found');
});


// Start the server
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
