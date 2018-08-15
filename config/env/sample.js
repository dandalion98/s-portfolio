// Rename this file to development.js or production.js for dev or production config.
module.exports = {
    stellarServer: "https://horizon.stellar.org",
    db: {
        "user": "postgres",
        "database": "sportfolio",
        "password": "postgres",
        "host": "localhost",
        "port": 5432,
        "max": 10,
        "idleTimeoutMillis": 30000
    },
    env: "dev"
}