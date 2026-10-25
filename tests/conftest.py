"""Enable worker-network observation before Playwright creates its driver."""
import os

os.environ["PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS"] = "1"
