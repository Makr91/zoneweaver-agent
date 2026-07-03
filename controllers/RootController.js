import Entities from '../models/EntityModel.js';
import { log } from '../lib/Logger.js';

/**
 * @swagger
 * /:
 *   get:
 *     summary: Root endpoint with links to registered frontends
 *     description: Renders a simple HTML page with a list of all registered Zoneweaverfrontends and a link to the API documentation.
 *     tags: [Root]
 *     security: []
 *     responses:
 *       200:
 *         description: HTML page with links
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *               example: "<!DOCTYPE html>..."
 *       500:
 *         description: Internal server error
 */
export const getRoot = async (req, res) => {
  void req;
  try {
    const entities = await Entities.findAll({
      where: { is_active: true },
      order: [['name', 'ASC']],
    });

    let html = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Zoneweaver Agent</title>
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; background-color: #1a1a1a; color: #e0e0e0; padding: 2rem; }
                    .container { max-width: 800px; margin: 0 auto; background-color: #2c2c2c; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 8px rgba(0,0,0,0.2); }
                    h1, h2 { color: #4CAF50; border-bottom: 2px solid #4CAF50; padding-bottom: 0.5rem; }
                    ul { list-style: none; padding: 0; }
                    li { margin-bottom: 1rem; }
                    .no-entities { color: #ffab40; }
                    a { color: #81c784; text-decoration: none; font-weight: bold; font-size: 1.1rem; }
                    a:hover { text-decoration: underline; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>Registered ZoneweaverInstances</h1>
        `;

    if (entities && entities.length > 0) {
      html += '<ul>';
      entities.forEach(entity => {
        const url = `https://${entity.name}`;
        html += `<li><a href="${url}" target="_blank" rel="noopener noreferrer">${entity.name}</a></li>`;
      });
      html += '</ul>';
    } else {
      html += '<p class="no-entities">No registered Zoneweaverinstances found.</p>';
    }

    html += `
                </div>
                <div class="container" style="margin-top: 2rem;">
                    <h2>API Documentation</h2>
                    <ul>
                        <li><a href="/api-docs" target="_blank" rel="noopener noreferrer">View API Docs</a></li>
                    </ul>
                </div>
            </body>
            </html>
        `;

    res.status(200).send(html);
  } catch (error) {
    log.api.error('Error fetching entities for root path', {
      error: error.message,
      stack: error.stack,
    });
    res
      .status(500)
      .send('<h1>Error 500: Internal Server Error</h1><p>Could not fetch entity list.</p>');
  }
};
