import { Router, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';

const router = Router();

// List policies
router.get('/', authenticate, requirePermission('policies.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await query(
      `SELECT p.*,
        (SELECT COUNT(*) FROM policy_groups pg WHERE pg.policy_id = p.id) AS group_count
       FROM compliance_policies p
       ORDER BY p.created_at DESC`
    );
    res.json({ success: true, data: { policies: result.rows } });
  } catch (error) { next(error); }
});

// Create policy
router.post('/', authenticate, requirePermission('policies.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { name, description, rules, group_ids } = req.body;
    const idResult = await query('SELECT uuid_generate_v4() AS id');
    const id = idResult.rows[0].id;

    await query(
      'INSERT INTO compliance_policies (id, name, description, rules, created_by, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, NOW(), NOW())',
      [id, name, description || '', JSON.stringify(rules || []), req.user?.id]
    );

    if (Array.isArray(group_ids)) {
      for (const groupId of group_ids) {
        const pgIdResult = await query('SELECT uuid_generate_v4() AS id');
        await query(
          'INSERT INTO policy_groups (id, policy_id, group_id, assigned_at) VALUES ($1, $2, $3, NOW())',
          [pgIdResult.rows[0].id, id, groupId]
        );
      }
    }

    res.status(201).json({ success: true, data: { id, name, description } });
  } catch (error) { next(error); }
});

// Get policy with assignments
router.get('/:id', authenticate, requirePermission('policies.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const policyResult = await query('SELECT * FROM compliance_policies WHERE id = $1', [id]);
    if (policyResult.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Policy not found' } });
      return;
    }

    const groupsResult = await query(
      `SELECT dg.* FROM device_groups dg
       JOIN policy_groups pg ON pg.group_id = dg.id
       WHERE pg.policy_id = $1`,
      [id]
    );

    res.json({
      success: true,
      data: { policy: { ...policyResult.rows[0], assigned_groups: groupsResult.rows } }
    });
  } catch (error) { next(error); }
});

// Update policy
router.put('/:id', authenticate, requirePermission('policies.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { name, description, rules, group_ids } = req.body;

    await query(
      'UPDATE compliance_policies SET name = COALESCE($1, name), description = COALESCE($2, description), rules = COALESCE($3, rules), updated_at = NOW() WHERE id = $4',
      [name ?? null, description ?? null, rules ? JSON.stringify(rules) : null, id]
    );

    if (Array.isArray(group_ids)) {
      await query('DELETE FROM policy_groups WHERE policy_id = $1', [id]);
      for (const groupId of group_ids) {
        const pgIdResult = await query('SELECT uuid_generate_v4() AS id');
        await query(
          'INSERT INTO policy_groups (id, policy_id, group_id, assigned_at) VALUES ($1, $2, $3, NOW())',
          [pgIdResult.rows[0].id, id, groupId]
        );
      }
    }

    res.json({ success: true, data: { message: 'Policy updated' } });
  } catch (error) { next(error); }
});

// Delete policy
router.delete('/:id', authenticate, requirePermission('policies.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    await query('DELETE FROM policy_groups WHERE policy_id = $1', [id]);
    await query('DELETE FROM compliance_policies WHERE id = $1', [id]);
    res.json({ success: true, data: { message: 'Policy deleted' } });
  } catch (error) { next(error); }
});

// Run compliance check on devices in assigned groups
router.post('/:id/check', authenticate, requirePermission('policies.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const policyResult = await query('SELECT * FROM compliance_policies WHERE id = $1', [id]);
    if (policyResult.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Policy not found' } });
      return;
    }

    const policy = policyResult.rows[0];
    const rules = typeof policy.rules === 'string' ? JSON.parse(policy.rules) : policy.rules;

    const devicesResult = await query(
      `SELECT DISTINCT d.* FROM devices d
       JOIN device_group_members dgm ON dgm.device_id = d.id
       JOIN policy_groups pg ON pg.group_id = dgm.group_id
       WHERE pg.policy_id = $1`,
      [id]
    );

    let checked = 0;
    let compliant = 0;
    let nonCompliant = 0;

    for (const device of devicesResult.rows) {
      const isCompliant = true;

      for (const rule of rules || []) {
        let rulePassed = true;

        if (rule.type === 'software_installed' && rule.value) {
          const swCheck = await query(
            'SELECT id FROM device_software WHERE device_id = $1 AND name ILIKE $2',
            [device.id, `%${rule.value}%`]
          );
          rulePassed = rule.operator === 'not_installed' ? swCheck.rows.length === 0 : swCheck.rows.length > 0;
        }

        if (rule.type === 'os_version' && rule.value) {
          const osCheck = await query(
            `SELECT id FROM devices WHERE id = $1 AND os_version ${rule.operator === 'equals' ? '=' : '!='} $2`,
            [device.id, rule.value]
          );
          rulePassed = osCheck.rows.length > 0;
        }

        if (!rulePassed) {
          await query(
            `INSERT INTO compliance_results (id, policy_id, device_id, rule_type, rule_value, passed, checked_at)
             VALUES (uuid_generate_v4(), $1, $2, $3, $4, false, NOW())`,
            [id, device.id, rule.type, rule.value || '']
          );
          nonCompliant++;
          break;
        }
      }

      if (isCompliant) {
        await query(
          `INSERT INTO compliance_results (id, policy_id, device_id, rule_type, rule_value, passed, checked_at)
           VALUES (uuid_generate_v4(), $1, $2, 'all_rules', '', true, NOW())`,
          [id, device.id]
        );
        compliant++;
      }

      checked++;
    }

    await query(
      'UPDATE compliance_policies SET last_checked_at = NOW() WHERE id = $1',
      [id]
    );

    res.json({
      success: true,
      data: {
        checked,
        compliant,
        non_compliant: nonCompliant,
        total_devices: devicesResult.rows.length
      }
    });
  } catch (error) { next(error); }
});

// Get compliance results
router.get('/:id/results', authenticate, requirePermission('compliance.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const results = await query(
      `SELECT cr.*, d.hostname, d.agent_id
       FROM compliance_results cr
       JOIN devices d ON d.id = cr.device_id
       WHERE cr.policy_id = $1
       ORDER BY cr.checked_at DESC`,
      [id]
    );

    res.json({ success: true, data: { results: results.rows } });
  } catch (error) { next(error); }
});

export default router;
