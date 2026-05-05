const axios = require('axios');

const SECRET_KEY = '6LdPPdosAAAAAOFlqrF3LHtbsoiXUo_OmsX78BAZ';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ success: false, error: 'Missing token' });
  }

  try {
    const response = await axios.post('https://www.google.com/recaptcha/api/siteverify', null, {
      params: {
        secret: SECRET_KEY,
        response: token
      }
    });

    const data = response.data;

    return res.json({
      success: data.success,
      error: data['error-codes']?.join(', ')
    });
  } catch (error) {
    console.error('reCAPTCHA verification error:', error.response?.data || error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
};
