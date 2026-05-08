const express = require('express');
const { query, sql } = require('../config/database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// POST /api/tickets/purchase - Compra de ingressos
router.post('/purchase', authMiddleware, async (req, res) => {
  try {
    const { items } = req.body; // [{ ticket_category_id, quantity }]
    const userId = req.user.id;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'Nenhum item para comprar' });
    }

    // Iniciar transação
    const pool = await require('../config/database').getConnection();
    const transaction = pool.transaction();
    await transaction.begin();

    try {
      let totalAmount = 0;
      const purchasedTickets = [];

      for (const item of items) {
        // Verificar disponibilidade
        const ticketResult = await transaction.request()
          .input('categoryId', sql.Int, item.ticket_category_id)
          .query(`
            SELECT tc.*, m.date as match_date, m.time as match_time,
                   ht.name as home_team, at.name as away_team, s.name as stadium
            FROM ticket_categories tc
            JOIN matches m ON tc.match_id = m.id
            LEFT JOIN teams ht ON m.home_team_id = ht.id
            LEFT JOIN teams at ON m.away_team_id = at.id
            LEFT JOIN stadiums s ON m.stadium_id = s.id
            WHERE tc.id = @categoryId
          `);

        if (ticketResult.recordset.length === 0) {
          throw new Error('Categoria de ingresso não encontrada');
        }

        const ticket = ticketResult.recordset[0];

        if (ticket.available_quantity <= 0) {
          const err = new Error(`Setor "${ticket.category}" esgotado`);
          err.statusCode = 400;
          throw err;
        }
        if (ticket.available_quantity < item.quantity) {
          const err = new Error(
            `Apenas ${ticket.available_quantity} ingressos disponíveis em "${ticket.category}" (você pediu ${item.quantity})`
          );
          err.statusCode = 400;
          throw err;
        }

        // Atualizar quantidade disponível
        await transaction.request()
          .input('categoryId', sql.Int, item.ticket_category_id)
          .input('quantity', sql.Int, item.quantity)
          .query(`
            UPDATE ticket_categories 
            SET available_quantity = available_quantity - @quantity
            WHERE id = @categoryId
          `);

        // Criar registro de compra
        const purchaseResult = await transaction.request()
          .input('userId', sql.Int, userId)
          .input('categoryId', sql.Int, item.ticket_category_id)
          .input('quantity', sql.Int, item.quantity)
          .input('unitPrice', sql.Decimal(10, 2), ticket.price)
          .input('totalPrice', sql.Decimal(10, 2), ticket.price * item.quantity)
          .query(`
            INSERT INTO purchases (user_id, ticket_category_id, quantity, unit_price, total_price, status, created_at)
            OUTPUT INSERTED.id
            VALUES (@userId, @categoryId, @quantity, @unitPrice, @totalPrice, 'completed', GETDATE())
          `);

        totalAmount += ticket.price * item.quantity;
        purchasedTickets.push({
          purchase_id: purchaseResult.recordset[0].id,
          match: `${ticket.home_team} vs ${ticket.away_team}`,
          category: ticket.category,
          quantity: item.quantity,
          unit_price: ticket.price,
          total: ticket.price * item.quantity
        });
      }

      await transaction.commit();

      res.status(201).json({
        message: 'Compra realizada com sucesso',
        total_amount: totalAmount,
        tickets: purchasedTickets
      });
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  } catch (err) {
    console.error('Erro na compra:', err);
    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({ error: err.message || 'Erro ao processar compra' });
  }
});

// GET /api/tickets/my-tickets - Meus ingressos
router.get('/my-tickets', authMiddleware, async (req, res) => {
  try {
    const result = await query(`
      SELECT 
        p.id, p.quantity, p.unit_price, p.total_price, p.status, p.created_at,
        tc.category,
        m.date as match_date, m.time as match_time, m.stage,
        ht.name as home_team, ht.flag as home_team_flag,
        at.name as away_team, at.flag as away_team_flag,
        s.name as stadium_name, s.city as stadium_city
      FROM purchases p
      JOIN ticket_categories tc ON p.ticket_category_id = tc.id
      JOIN matches m ON tc.match_id = m.id
      LEFT JOIN teams ht ON m.home_team_id = ht.id
      LEFT JOIN teams at ON m.away_team_id = at.id
      LEFT JOIN stadiums s ON m.stadium_id = s.id
      WHERE p.user_id = @param0
      ORDER BY p.created_at DESC
    `, [req.user.id]);

    res.json({ tickets: result.recordset });
  } catch (err) {
    console.error('Erro ao buscar ingressos:', err);
    res.status(500).json({ error: 'Erro ao buscar ingressos' });
  }
});

module.exports = router;
