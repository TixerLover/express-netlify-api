import express from 'express';
import serverless from 'serverless-http';
import nodemailer from 'nodemailer';
import { getStore, connectLambda } from '@netlify/blobs';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const router = express.Router();

app.use(express.json());

// Conectar el evento crudo de AWS Lambda/Netlify con @netlify/blobs
app.use((req, res, next) => {
  if (req.lambdaEvent) {
    connectLambda(req.lambdaEvent);
  }
  next();
});

// =============================================================
// MIDDLEWARES Y HELPERS
// =============================================================
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

function obtenerAlmacenMetricas() {
  return getStore({
    name: 'funnel-metrics',
    consistency: 'strong'
  });
}

// =============================================================
// TUS RUTAS ORIGINALES (/api/time y /api/send-email)
// =============================================================
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
      },
      tls: {
        rejectUnauthorized: false
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

// =============================================================
// ENDPOINT 1: Registrar evento en el funnel (POST /api/metrics)
// =============================================================
router.post('/metrics', async (req, res) => {
  try {
    const { step, source, sessionId, metadata } = req.body;

    if (!step || !source) {
      return res.status(400).json({
        status: 'error',
        message: 'Los campos "step" y "source" son obligatorios.'
      });
    }

    const randomSuffix = Math.random().toString(36).substring(2, 7);
    const eventId = `metric_${Date.now()}_${randomSuffix}`;
    const timestamp = new Date().toISOString();

    const metricRecord = {
      id: eventId,
      step: String(step).toLowerCase().trim(),
      source: String(source).toLowerCase().trim(),
      sessionId: sessionId || 'anon_guest',
      metadata: metadata || {},
      timestamp
    };

    const store = obtenerAlmacenMetricas();
    await store.set(eventId, JSON.stringify(metricRecord));

    return res.status(201).json({
      status: 'success',
      message: 'Métrica persistida correctamente en Netlify Blobs.',
      data: metricRecord
    });
  } catch (error) {
    console.error('Error al registrar métrica:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Fallo interno al persistir la métrica.',
      details: error.message
    });
  }
});

// =============================================================
// ENDPOINT 2: Consultar y resumir métricas (GET /api/metrics)
// =============================================================
router.get('/metrics', async (req, res) => {
  try {
    const { step, source } = req.query;
    const store = obtenerAlmacenMetricas();
    const { blobs } = await store.list();

    const eventosRecientes = await Promise.all(
      blobs.slice(0, 50).map(async (blob) => {
        return await store.get(blob.key, { type: 'json' });
      })
    );

    let eventosValidos = eventosRecientes.filter(Boolean);

    if (step) {
      eventosValidos = eventosValidos.filter(
        (e) => e.step === String(step).toLowerCase().trim()
      );
    }
    if (source) {
      eventosValidos = eventosValidos.filter(
        (e) => e.source === String(source).toLowerCase().trim()
      );
    }

    const summary = {
      totalEvents: eventosValidos.length,
      byStep: {},
      bySource: {}
    };

    for (const evento of eventosValidos) {
      summary.byStep[evento.step] = (summary.byStep[evento.step] || 0) + 1;
      summary.bySource[evento.source] = (summary.bySource[evento.source] || 0) + 1;
    }

    return res.status(200).json({
      status: 'success',
      data: {
        summary,
        recentEvents: eventosValidos
      }
    });
  } catch (error) {
    console.error('Error al consultar métricas:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Fallo interno al consultar métricas en Netlify Blobs.',
      details: error.message
    });
  }
});

// =============================================================
// RETO 3: Exportación de métricas a CSV (GET /api/metrics/export?format=csv)
// =============================================================
router.get('/metrics/export', async (req, res) => {
  try {
    const { format } = req.query;

    if (format !== 'csv') {
      return res.status(400).json({
        status: 'error',
        message: 'Formato no soportado. Usa el parámetro ?format=csv en la URL.'
      });
    }

    const store = obtenerAlmacenMetricas();
    const { blobs } = await store.list();

    const eventos = await Promise.all(
      blobs.map(async (blob) => {
        return await store.get(blob.key, { type: 'json' });
      })
    );

    const eventosValidos = eventos.filter(Boolean);

    const escaparCeldaCSV = (valor) => {
      const texto = String(valor ?? '');
      if (texto.includes(',') || texto.includes('"') || texto.includes('\n')) {
        return `"${texto.replace(/"/g, '""')}"`;
      }
      return texto;
    };

    const encabezados = ['id', 'step', 'source', 'sessionId', 'timestamp'];
    const filas = eventosValidos.map((evento) => [
      escaparCeldaCSV(evento.id),
      escaparCeldaCSV(evento.step),
      escaparCeldaCSV(evento.source),
      escaparCeldaCSV(evento.sessionId),
      escaparCeldaCSV(evento.timestamp)
    ].join(','));

    const contenidoCSV = [encabezados.join(','), ...filas].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="metricas_funnel.csv"');

    return res.status(200).send(contenidoCSV);
  } catch (error) {
    console.error('Error al exportar métricas a CSV:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Fallo interno al generar el archivo CSV.',
      details: error.message
    });
  }
});

// =============================================================
// VINCULAR ROUTER Y EXPORTAR HANDLER CON EVENTO LAMBDA
// =============================================================
app.use('/api', router);

export const handler = serverless(app, {
  request: (request, event) => {
    request.lambdaEvent = event;
  }
});