"""Local-only red/white campus-card crop experiment; not a generic card detector."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / '.release-evidence/crop-python-deps'))
import cv2
import numpy as np


def locate(image):
    height, width = image.shape[:2]
    scale = min(1, 1400 / max(height, width))
    small = cv2.resize(image, None, fx=scale, fy=scale)
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
    mask = (((hsv[:, :, 0] < 13) | (hsv[:, :, 0] > 167)) &
            (hsv[:, :, 1] > 85) & (hsv[:, :, 2] > 35)).astype('uint8') * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    candidates = []
    for contour in contours:
        area = cv2.contourArea(contour)
        if area < small.shape[0] * small.shape[1] * .006:
            continue
        perimeter = cv2.arcLength(contour, True)
        polygon = cv2.approxPolyDP(contour, .035 * perimeter, True)
        if len(polygon) == 4 and cv2.isContourConvex(polygon):
            points = polygon[:, 0, :].astype(np.float32)
        else:
            points = cv2.boxPoints(cv2.minAreaRect(contour))
        points = points[np.argsort(points[:, 1])]
        top = points[:2][np.argsort(points[:2, 0])]
        bottom = points[2:][np.argsort(points[2:, 0])]
        tl, tr = top
        bl, br = bottom
        card_width = (np.linalg.norm(tr-tl) + np.linalg.norm(br-bl)) / 2
        red_height = (np.linalg.norm(bl-tl) + np.linalg.norm(br-tr)) / 2
        if not .65 < red_height / card_width < 1.5:
            continue
        # This design has a red upper panel and a white lower identity panel.
        # Include a lower margin: a clipped side underestimates the real card width.
        full_height = card_width * 1.78
        factor = full_height / red_height
        quad = np.array([tl, tr, tr + (br-tr)*factor, tl + (bl-tl)*factor]) / scale
        candidates.append((area, quad))
    if not candidates:
        raise ValueError('No reliable red-card candidate; manual crop required')
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1], len(candidates)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('source')
    parser.add_argument('output')
    args = parser.parse_args()
    image = cv2.imdecode(np.fromfile(args.source, np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError('Image could not be decoded')
    quad, count = locate(image)
    h, w = image.shape[:2]
    clipped = bool(np.any(quad[:, 0] < 2) or np.any(quad[:, 0] > w-3) or
                   np.any(quad[:, 1] < 2) or np.any(quad[:, 1] > h-3))
    out_width = max(100, round((np.linalg.norm(quad[1]-quad[0]) + np.linalg.norm(quad[2]-quad[3])) / 2))
    out_height = round(out_width * 1.78)
    target = np.float32([[0, 0], [out_width-1, 0], [out_width-1, out_height-1], [0, out_height-1]])
    matrix = cv2.getPerspectiveTransform(quad.astype(np.float32), target)
    crop = cv2.warpPerspective(image, matrix, (out_width, out_height), borderValue=(240, 240, 240))
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    cv2.imencode('.jpg', crop, [cv2.IMWRITE_JPEG_QUALITY, 95])[1].tofile(str(output))
    print(json.dumps({'output': str(output), 'size': [out_width, out_height],
                      'possibly_clipped': clipped, 'candidates': count,
                      'status': 'experimental_manual_review_required'}))


if __name__ == '__main__':
    main()
