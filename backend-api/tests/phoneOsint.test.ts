/**
 * Phone OSINT module: Angola prefix operator mapping + HLR/Hiya response parsing.
 * Run: npx tsx tests/phoneOsint.test.ts
 */
import assert from 'assert';
import * as phoneOsint from '../src/osint/phoneOsint';

let failed = 0;
const check = (label: string, fn: () => void) => {
  try {
    fn();
    console.log(`  ok  ${label}`);
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}`);
    console.error(`      ${(error as Error).message}`);
  }
};
const checkAsync = async (label: string, fn: () => Promise<void>) => {
  try {
    await fn();
    console.log(`  ok  ${label}`);
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}`);
    console.error(`      ${(error as Error).message}`);
  }
};

// --- operatorFromPrefix (Angola) ---

check('Unitel prefix 92', () => {
  const r = phoneOsint.operatorFromPrefix('+244923445618');
  assert.strictEqual(r?.operator, 'Unitel');
  assert.strictEqual(r?.type, 'mobile');
});

check('Unitel prefix 93', () => {
  assert.strictEqual(phoneOsint.operatorFromPrefix('+244935603163')?.operator, 'Unitel');
});

check('Unitel prefix 94', () => {
  assert.strictEqual(phoneOsint.operatorFromPrefix('+244941234567')?.operator, 'Unitel');
});

check('Unitel prefix 97', () => {
  assert.strictEqual(phoneOsint.operatorFromPrefix('+244971234567')?.operator, 'Unitel');
});

check('Movicel prefix 91', () => {
  const r = phoneOsint.operatorFromPrefix('+244911234567');
  assert.strictEqual(r?.operator, 'Movicel');
  assert.strictEqual(r?.type, 'mobile');
});

check('Movicel prefix 99', () => {
  assert.strictEqual(phoneOsint.operatorFromPrefix('+244991234567')?.operator, 'Movicel');
});

check('Africell prefix 95', () => {
  const r = phoneOsint.operatorFromPrefix('+244951234567');
  assert.strictEqual(r?.operator, 'Africell');
  assert.strictEqual(r?.type, 'mobile');
});

check('Africell prefix 96', () => {
  assert.strictEqual(phoneOsint.operatorFromPrefix('+244961234567')?.operator, 'Africell');
});

check('Angola Telecom fixed 222', () => {
  const r = phoneOsint.operatorFromPrefix('+244222123456');
  assert.strictEqual(r?.operator, 'Angola Telecom');
  assert.strictEqual(r?.type, 'fixed');
});

check('non-Angola number returns null', () => {
  assert.strictEqual(phoneOsint.operatorFromPrefix('+351912345678'), null);
});

check('number without country code returns null', () => {
  assert.strictEqual(phoneOsint.operatorFromPrefix('935603163'), null);
});

// --- parseHlrResponse ---

check('parseHlrResponse maps hlrlookup.com payload', () => {
  const parsed = phoneOsint.parseHlrResponse({
    body: {
      results: [{
        error: 'NONE',
        detected_telephone_number: '244935603163',
        live_status: 'LIVE',
        telephone_number_type: 'MOBILE',
        original_network_details: { name: 'Unitel S.A.', mccmnc: '63102', country_iso3: 'AGO' },
        current_network_details: { name: 'Unitel S.A.', mccmnc: '63102', country_iso3: 'AGO' },
        is_ported: 'NO',
      }],
    },
  });
  assert.ok(parsed);
  assert.strictEqual(parsed!.connectivity, 'LIVE');
  assert.strictEqual(parsed!.originalNetwork, 'Unitel S.A.');
  assert.strictEqual(parsed!.currentNetwork, 'Unitel S.A.');
  assert.strictEqual(parsed!.mccmnc, '63102');
  assert.strictEqual(parsed!.isPorted, false);
  assert.strictEqual(parsed!.roaming, false);
});

check('parseHlrResponse returns null on API error', () => {
  assert.strictEqual(phoneOsint.parseHlrResponse({ body: { results: [{ error: 'BAD_NUMBER' }] } }), null);
});

check('parseHlrResponse handles missing payload', () => {
  assert.strictEqual(phoneOsint.parseHlrResponse({}), null);
  assert.strictEqual(phoneOsint.parseHlrResponse(null), null);
});

// --- parseHiyaProfile ---

check('parseHiyaProfile maps identity + reputation', () => {
  const parsed = phoneOsint.parseHiyaProfile({
    result: {
      displayName: 'Banco XYZ',
      profileDetails: { reputationCategoryName: 'PREMIUM_TOLL' },
    },
    isSpam: true,
  });
  assert.ok(parsed);
  assert.strictEqual(parsed!.displayName, 'Banco XYZ');
  assert.strictEqual(parsed!.category, 'PREMIUM_TOLL');
  assert.strictEqual(parsed!.isSpam, true);
});

check('parseHiyaProfile returns null when empty', () => {
  assert.strictEqual(phoneOsint.parseHiyaProfile({}), null);
  assert.strictEqual(phoneOsint.parseHiyaProfile(null), null);
  assert.strictEqual(phoneOsint.parseHiyaProfile({ result: {} }), null);
});

// --- lookupPhone integration (local, no keys) ---

const run = async () => {
  await checkAsync('lookupPhone Angola number includes prefix operator', async () => {
    const res = await phoneOsint.lookupPhone('+244935603199');
    assert.strictEqual(res.success, true);
    assert.ok(res.data);
    assert.strictEqual(res.data!.valid, true);
    assert.strictEqual(res.data!.countryCode, 'AO');
    assert.strictEqual(res.data!.prefixOperator, 'Unitel');
    assert.strictEqual(res.data!.prefixType, 'mobile');
  });

  await checkAsync('lookupPhone without + normalizes to E.164', async () => {
    const res = await phoneOsint.lookupPhone('244935603164');
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.data!.e164, '+244935603164');
  });

  await checkAsync('lookupPhone non-Angola has no prefixOperator', async () => {
    const res = await phoneOsint.lookupPhone('+351912345678');
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.data!.prefixOperator, undefined);
  });

  await checkAsync('lookupPhone rejects invalid number', async () => {
    const res = await phoneOsint.lookupPhone('abc');
    assert.strictEqual(res.success, false);
  });

  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log('\nAll phone OSINT tests passed');
};

run();
