import { Button } from '@mui/material';
import { useState } from 'react';

interface CopyButtonProps {
  numbers: number[];
  label?: string;
  size?: 'small' | 'medium';
}

export default function CopyButton({ numbers, label = '복사', size = 'small' }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const text = numbers.join(', ');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  return (
    <Button size={size} variant="text" onClick={handleCopy} sx={{ minWidth: 56 }}>
      {copied ? '완료' : label}
    </Button>
  );
}
