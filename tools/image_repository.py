"""화면 이미지 생성기는 게임 소스 대신 명시한 이미지 저장소에 쓴다."""
import os
from pathlib import Path


def image_repository():
    value = os.environ.get('OPENSAMGUK_IMAGES_DIRECTORY', '')
    if not value or not Path(value).is_absolute():
        raise SystemExit('OPENSAMGUK_IMAGES_DIRECTORY에 이미지 저장소의 절대 경로를 지정하세요.')
    root = Path(value).resolve()
    if not (root / '.git').exists():
        raise SystemExit('이미지 저장소 checkout을 확인하세요.')
    return root
