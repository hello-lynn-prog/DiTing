import argparse
import uvicorn

from .api import create_app


def main():
    parser = argparse.ArgumentParser(description="DiTing local single-user application")
    parser.add_argument("--port", type=int, default=8090)
    args = parser.parse_args()
    # Deliberately loopback only; multi-user hosting/authentication is a separate milestone.
    uvicorn.run(create_app(), host="127.0.0.1", port=args.port, access_log=False)


if __name__ == "__main__":
    main()

