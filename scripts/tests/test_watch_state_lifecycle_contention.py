import unittest

from watch_state_lifecycle_contention import record_hour


class ContentionWatchTest(unittest.TestCase):
    def test_counts_legacy_structured_error_without_new_holder_fields(self):
        line = (
            '{"time":"2026-10-03T08:10:44-04:00",'
            '"message":"turn failed",'
            '"error":{"name":"StateDatabaseCoordinatorContentionError",'
            '"family":"state-lifecycle"}}'
        )
        self.assertEqual(record_hour(line), "2026-10-03T12:00Z")

    def test_counts_new_diagnostic_line_once(self):
        line = (
            '{"time":"2026-10-03T08:10:44-04:00",'
            '"0":"{\\"subsystem\\":\\"state/coordinator\\"}",'
            '"message":"another OpenClaw process owns state-lifecycle '
            '(holder_pid=555 holder_thread_id=3460 holder_operation=database-verify '
            'holder_held_ms=800)"}'
        )
        self.assertEqual(record_hour(line), "2026-10-03T12:00Z")

    def test_ignores_other_families(self):
        line = (
            '{"time":"2026-10-03T08:10:44-04:00",'
            '"error":{"name":"StateDatabaseCoordinatorContentionError",'
            '"family":"state-handles"}}'
        )
        self.assertIsNone(record_hour(line))

    def test_ignores_quoted_contention_in_unrelated_log(self):
        line = (
            '{"time":"2026-10-03T08:10:44-04:00",'
            '"0":"{\\"subsystem\\":\\"agents/turn\\"}",'
            '"message":"User quoted: another OpenClaw process owns state-lifecycle"}'
        )
        self.assertIsNone(record_hour(line))

    def test_counts_legacy_diagnostic_error(self):
        line = (
            '{"time":"2026-10-03T08:32:25-04:00",'
            '"0":"{\\"subsystem\\":\\"diagnostic\\"}",'
            '"1":{"errorName":"StateDatabaseCoordinatorContentionError"},'
            '"2":"lane task error: error=\\"another OpenClaw process owns state-lifecycle\\""}'
        )
        self.assertEqual(record_hour(line), "2026-10-03T12:00Z")

    def test_counts_legacy_embedded_agent_error(self):
        line = (
            '{"time":"2026-10-03T08:32:25-04:00",'
            '"0":"Embedded agent failed before reply: another OpenClaw process owns state-lifecycle"}'
        )
        self.assertEqual(record_hour(line), "2026-10-03T12:00Z")


    def test_counts_state_owner_line_from_9_8(self):
        line = (
            '{"time":"2026-10-03T18:10:44-04:00",'
            '"0":"{\\"subsystem\\":\\"state/owner\\"}",'
            '"1":"state owner contention at /home/u/.openclaw/state/openclaw.sqlite: '
            'holder_pid=555 holder_role=gateway holder_kind=process holder_held_ms=800"}'
        )
        self.assertEqual(record_hour(line), "2026-10-03T22:00Z")

    def test_counts_structured_state_owner_error_from_9_8(self):
        line = (
            '{"time":"2026-10-03T18:10:44-04:00",'
            '"message":"turn failed",'
            '"error":{"name":"GatewayStateOwnerContentionError",'
            '"databasePath":"/home/u/.openclaw/state/openclaw.sqlite"}}'
        )
        self.assertEqual(record_hour(line), "2026-10-03T22:00Z")

    def test_ignores_quoted_state_owner_phrase_in_unrelated_log(self):
        line = (
            '{"time":"2026-10-03T18:10:44-04:00",'
            '"0":"{\\"subsystem\\":\\"agents/turn\\"}",'
            '"message":"User quoted: state owner contention at /tmp/x"}'
        )
        self.assertIsNone(record_hour(line))

if __name__ == "__main__":
    unittest.main()
