import { jsx as _jsx } from "react/jsx-runtime";
import { Button } from '@mui/material';
import { useState } from 'react';
export default function CopyButton({ numbers, label = '복사', size = 'small' }) {
    const [copied, setCopied] = useState(false);
    const handleCopy = async () => {
        const text = numbers.join(', ');
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        }
        catch {
            /* ignore */
        }
    };
    return (_jsx(Button, { size: size, variant: "text", onClick: handleCopy, sx: { minWidth: 56 }, children: copied ? '완료' : label }));
}
