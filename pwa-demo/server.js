const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3020;

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`PWA demo server running on port ${PORT}`);
});
