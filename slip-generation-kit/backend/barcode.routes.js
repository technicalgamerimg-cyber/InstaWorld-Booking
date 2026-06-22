// barcode.routes.js
//
// Single Express endpoint that renders a Code-128 barcode PNG using bwip-js.
//
// Why this lives on the backend: bwip-js works in the browser too, but bundling
// it inflates the JS payload and some Next.js SSR setups choke on it. Hosting
// the renderer behind a tiny HTTP endpoint keeps the frontend bundle small.
//
// Install:  npm i bwip-js
//
// Mount in your Express app:
//   import barcodeRoutes from './slip-generation-kit/backend/barcode.routes.js';
//   app.use('/api/barcode', barcodeRoutes);

import express from 'express';
import bwipjs from 'bwip-js';

const router = express.Router();

/**
 * GET /api/barcode/:text?scale=3&includeText=true
 *
 * Path param  : text         — string to encode (URL-encoded by the caller)
 * Query param : scale        — integer scaling factor, default 3
 * Query param : includeText  — "true" | "false", default "true"
 *
 * Response    : image/png
 */
router.get('/:text', async (req, res) => {
  try {
    const text = req.params.text;
    const scale = Number(req.query.scale) || 3;
    const includeText = req.query.includeText === 'false' ? false : true;

    const buffer = await bwipjs.toBuffer({
      bcid: 'code128',
      text: String(text),
      scale,
      height: 10,        // mm — bar height
      includetext: includeText,
      textxalign: 'center',
    });

    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400, immutable'); // identical input → identical PNG
    res.send(buffer);
  } catch (err) {
    console.error('barcode generation failed:', err);
    res.status(500).send('Failed to generate barcode');
  }
});

export default router;
