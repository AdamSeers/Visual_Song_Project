import { useState } from 'react'

interface SliderProps {
    id: string
    name: string
    label: string
    description: string
    min: number
    max: number
    step: number
    defaultValue: number
}

export default function Slider({
    id, name, label, description, min, max, step, defaultValue,
}: SliderProps) {
    const [value, setValue] = useState(defaultValue)
    const isFloat = String(step).indexOf('.') >= 0
    return (
        <div className="control">
            <label htmlFor={id}>
                <span className="control-name">{label}</span>
                <span className="control-desc">{description}</span>
            </label>
            <div className="control-row">
                <input
                    type="range"
                    id={id}
                    name={name}
                    min={min}
                    max={max}
                    step={step}
                    value={value}
                    onChange={(e) => setValue(parseFloat(e.target.value))}
                />
                <output>{isFloat ? value.toFixed(2) : String(value)}</output>
            </div>
        </div>
    )
}