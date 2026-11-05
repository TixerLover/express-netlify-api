import express from 'express';
import serverless from 'serverless-http';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const router = express.Router();

app.use(express.json());

const requireApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== process.env.API_SECRET_KEY) {
    return res.status(401).json({
      status: 'error',
      message: 'Unauthorized: Cabecera x-api-key ausente o inválida.'
    });
  }
  next();
};

function esCorreoValido(email) {
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regex.test(email);
}

router.get('/time', (req, res) => {
  const now = new Date();
  return res.status(200).json({
    status: 'success',
    data: {
      serverTimeISO: now.toISOString(),
      timestamp: now.getTime(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      formatted: now.toUTCString(),
      platform: 'Netlify Functions (AWS Lambda)'
    }
  });
});

router.post('/send-email', requireApiKey, async (req, res) => {
  try {
    const { to, subject, message, senderName } = req.body;

    if (!to || !subject || !message) {
      return res.status(400).json({
        status: 'error',
        message: 'Parámetros obligatorios faltantes: to, subject y message son requeridos.'
      });
    }

    if (!esCorreoValido(to)) {
      return res.status(400).json({
        status: 'error',
        message: 'El formato de correo en el campo "to" no es válido.'
      });
    }

    const sanitizedSubject = subject.replace(/[\r\n]/g, '');

    const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM } = process.env;

    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
      return res.status(500).json({
        status: 'error',
        message: 'Servicio de correo no configurado en el servidor.'
      });
    }

    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT) || 587,
      secure: Number(SMTP_PORT) === 465,
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS
      }
    });

    const displayName = senderName ? senderName : 'Sistema Automatizado';
    const htmlTemplate = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
        <h2 style="color: #2b2d42;">Notificación del Sistema</h2>
        <p style="font-size: 16px; color: #555;">${message}</p>
        <hr />
        <p style="font-size: 14px; color: #888;">Remitente: <strong>${displayName}</strong></p>
        <small style="color: #aaa;">Enviado mediante Netlify Express API a las ${new Date().toUTCString()}</small>
      </div>
    `;

    const info = await transporter.sendMail({
      from: EMAIL_FROM || `"API Serverless" <${SMTP_USER}>`,
      to,
      subject: sanitizedSubject,
      text: message,
      html: htmlTemplate
    });

    return res.status(200).json({
      status: 'success',
      message: 'Correo despachado satisfactoriamente.',
      data: {
        messageId: info.messageId,
        recipient: to
      }
    });

  } catch (error) {
    console.error('Error al procesar envío:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Fallo interno al despachar el correo.',
      details: error.message
    });
  }
});

app.use('/api', router);
export const handler = serverless(app);