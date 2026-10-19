"""The mask (sessions.redact) against a corpus: every credential shape is hidden, ordinary text a developer writes
all day (SHAs, PR numbers, UUIDs, paths, prose about tokens) stays readable."""
import unittest

from office.sessions import redact

# Fake values, built here so no real-looking key sits in the source as one string.
A = "A1b2C3d4E5f6G7h8I9j0" * 3
SECRETS = {
    "anthropic": "sk-ant-api03-" + A,
    "openai project": "sk-proj-" + A,
    "github pat": "ghp_" + A[:36],
    "github fine-grained": "github_pat_" + A[:40],
    "gitlab": "glpat-" + A[:20],
    "slack token": "xoxb-1234567890-" + A[:24],
    "slack webhook": "https://hooks.slack.com/services/T0000/B0000/" + A[:24],
    "aws access key": "AKIA" + "ABCDEFGHIJKLMNOP",
    "aws secret": "aws_secret_access_key=" + A[:40],
    "aws secret spaced": "aws_secret_access_key " + A[:40],
    "stripe live": "sk_live_" + A[:24],
    "stripe restricted": "rk_test_" + A[:24],
    "google api": "AIza" + A[:35],
    "npm": "npm_" + A[:36],
    "hugging face": "hf_" + A[:34],
    "jwt": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "bearer": "Authorization: Bearer " + A[:32],
    "env password": "DB_PASSWORD=" + A[:16],
    "env secret": "export CLIENT_SECRET='" + A[:20] + "'",
    "json token": '{"api_key": "' + A[:24] + '"}',
    "url password": "postgres://admin:" + A[:12] + "@db.internal:5432/app",
    "curl user": "curl -u deploy:" + A[:12] + " https://example.invalid",
    "mysql": "mysql -uroot -p" + A[:12] + " app",
}
PRIVATE_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\n" + (A + A)[:64] + "\n" + (A + A)[3:67] + "\n-----END OPENSSH PRIVATE KEY-----"
SAFE = [
    "merged 4bd4336580000000000000000000000000000000 in PR #1630",
    "commit 4cb86f6: tests pass",
    "session 6be0cfa4-fe3c-4861-be8f-f0573597b48f resumed",
    "/home/user/project/office/tokens.py:327",
    "The token counter double-counts after a rescan.",
    "Fix the password reset flow in auth.py",
    "api_key handling moved to settings.py",
    "secret santa list",
    "tokens: 1,234,567 (418.1 M fresh)",
    "docker run -u 1000:1000 image",
    "BEGIN TRANSACTION; UPDATE users SET name = 'x';",
    "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
]


class RedactCorpusTests(unittest.TestCase):
    def test_every_credential_shape_is_hidden(self):
        for name, s in SECRETS.items():
            with self.subTest(name=name):
                out = redact(f"before {s} after")
                self.assertIn("[hidden]", out)
                self.assertNotIn(A[8:20], out)                 # the distinctive middle of the value is gone
                self.assertTrue(out.startswith("before") and out.endswith("after"))

    def test_a_private_key_block_is_hidden_whole(self):
        out = redact("key:\n" + PRIVATE_KEY + "\nthen more")
        self.assertNotIn(A[8:20], out)
        self.assertIn("then more", out)

    def test_ordinary_text_stays_readable(self):
        for s in SAFE:
            with self.subTest(s=s):
                self.assertEqual(redact(s), s)


if __name__ == "__main__":
    unittest.main()
