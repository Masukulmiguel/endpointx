import { Router, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';

const router = Router();

const normalizeRules = (rules: any): any[] => {
  if (Array.isArray(rules)) return rules;
  if (rules && typeof rules === 'object') {
    return Object.entries(rules)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([key, value]) => ({ type: key, operator: 'equals', value }));
  }
  return [];
};

// Stats
router.get('/stats', authenticate, requirePermission('policies.view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const [totalRes, activeRes] = await Promise.all([
      query('SELECT COUNT(*) as count FROM compliance_policies'),
      query('SELECT COUNT(*) as count FROM compliance_policies WHERE is_active = true'),
    ]);
    const total = parseInt(totalRes.rows[0]?.count || '0', 10);
    const active = parseInt(activeRes.rows[0]?.count || '0', 10);
    let complianceRate = 0;
    if (total > 0) {
      const results = await query(
        `SELECT COUNT(DISTINCT device_id) AS checked,
                COUNT(DISTINCT device_id) FILTER (WHERE is_compliant) AS ok
         FROM compliance_results`
      );
      const checked = parseInt(results.rows[0]?.checked || '0', 10);
      const ok = parseInt(results.rows[0]?.ok || '0', 10);
      complianceRate = checked > 0 ? Math.round((ok / checked) * 100) : 0;
    }
    res.json({ success: true, data: { total, active, compliance_rate: complianceRate } });
  } catch (error) { next(error); }
});

// List policies
router.get('/', authenticate, requirePermission('policies.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await query(
      `SELECT p.*,
        (SELECT COUNT(*) FROM policy_assignments pa WHERE pa.policy_id = p.id) AS group_count
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
      'INSERT INTO compliance_policies (id, name, description, rules, is_active, created_at, updated_at) VALUES ($1, $2, $3, $4, true, NOW(), NOW())',
      [id, name, description || '', JSON.stringify(rules || {})]
    );

    if (Array.isArray(group_ids)) {
      for (const groupId of group_ids) {
        await query(
          'INSERT INTO policy_assignments (policy_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [id, groupId]
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
       JOIN policy_assignments pa ON pa.group_id = dg.id
       WHERE pa.policy_id = $1`,
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
      await query('DELETE FROM policy_assignments WHERE policy_id = $1', [id]);
      for (const groupId of group_ids) {
        await query(
          'INSERT INTO policy_assignments (policy_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [id, groupId]
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
    await query('DELETE FROM policy_assignments WHERE policy_id = $1', [id]);
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
    const rules = normalizeRules(typeof policy.rules === 'string' ? JSON.parse(policy.rules) : policy.rules);

    const devicesResult = await query(
      `SELECT DISTINCT d.* FROM devices d
       JOIN device_group_members dgm ON dgm.device_id = d.id
       JOIN policy_assignments pa ON pa.group_id = dgm.group_id
       WHERE pa.policy_id = $1`,
      [id]
    );

    let checked = 0;
    let compliant = 0;
    let nonCompliant = 0;
    const resultRows: any[] = [];

    for (const device of devicesResult.rows) {
      let deviceCompliant = true;
      const violations: string[] = [];

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
          deviceCompliant = false;
          violations.push(`${rule.type}: expected ${rule.operator || 'match'} ${rule.value}`);
        }
      }

      const insertRes = await query(
        `INSERT INTO compliance_results (id, policy_id, device_id, is_compliant, violations, checked_at)
         VALUES (uuid_generate_v4(), $1, $2, $3, $4, NOW())
         RETURNING id, checked_at`,
        [id, device.id, deviceCompliant, JSON.stringify(violations)]
      );

      resultRows.push({
        id: insertRes.rows[0].id,
        device_id: device.id,
        device_name: device.hostname,
        policy_id: id,
        is_compliant: deviceCompliant,
        violations,
        checked_at: insertRes.rows[0].checked_at,
      });

      if (deviceCompliant) compliant++;
      else nonCompliant++;
      checked++;
    }

    await query(
      'UPDATE compliance_policies SET updated_at = NOW() WHERE id = $1',
      [id]
    );

    res.json({
      success: true,
      data: {
        checked,
        compliant,
        non_compliant: nonCompliant,
        total_devices: devicesResult.rows.length,
        results: resultRows
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
