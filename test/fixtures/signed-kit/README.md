# Signed runtime kit fixture

These files come from the setup-packet generator in the service repository at
171ae3008a008f5bb7deb6863f16d4066e69206b. The bootstrap is the canonical runtime
bootstrap. The workflow uses the replay-only route and contains no customer
setup steps. These are generated contract artifacts, not production traffic.

Tests copy the files into real temporary repositories. They do not replace the
filesystem, child processes, or the bootstrap with mocks.
