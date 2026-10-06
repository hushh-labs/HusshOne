import multiprocessing
import uvicorn
from app.config import settings
from app.runtime_logging import configure_logging, install_exception_hooks

if __name__ == "__main__":
    multiprocessing.freeze_support()
    install_exception_hooks(configure_logging())
    print(f"==================================================")
    print(f"Starting {settings.APP_NAME}")
    print(f"Target Database: {settings.CLOUD_SQL_INSTANCE} (hotel_scraper)")
    print(f"Dashboard URL  : http://{settings.HOST}:{settings.PORT}")
    print(f"==================================================")
    uvicorn.run(
        "app.main:app",
        host=settings.HOST,
        port=settings.PORT,
        # The development reloader forks a second process and can restart an
        # unattended worker unexpectedly.  Production supervision owns restarts.
        reload=False,
    )
