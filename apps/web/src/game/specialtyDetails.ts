type DomesticSpecialty = {
  name: string;
  commands: readonly string[];
  score: number;
  cost: number;
  successBonus: number;
};

export function domesticSpecialtyDetails(specialty: DomesticSpecialty | null | undefined) {
  const specialtyActions: Record<string, string> = {
    farm: '농지 개간',
    commerce: '상업 투자',
    security: '치안 강화',
    goodwill: '주민 선정',
    settle: '정착 장려',
    defence: '수비 강화',
    wall: '성벽 보수',
    research: '기술 연구',
    stratagem: '계략',
  };
  return specialty
    ? [
        specialty.commands.map((key) => specialtyActions[key] ?? key).join('·'),
        specialty.score !== 1 && `효과 +${Math.round((specialty.score - 1) * 100)}%`,
        specialty.cost !== 1 && `비용 −${Math.round((1 - specialty.cost) * 100)}%`,
        `${specialty.name === '귀모' ? '성공률' : '대성공률'} +${Math.round(specialty.successBonus * 100)}%p`,
      ]
        .filter(Boolean)
        .join(' · ')
    : undefined;
}
