const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3010;

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`English game server running on port ${PORT}`);
});
