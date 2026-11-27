import { Pressable, StyleSheet } from 'react-native'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'

interface MediaActionProps {
  children: string
  onPress: () => void
  kind?: 'primary' | 'secondary' | 'danger'
  disabled?: boolean
}

export default function MediaAction({ children, onPress, kind = 'secondary', disabled = false }: MediaActionProps) {
  const theme = useTheme()
  const primary = kind === 'primary'

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.action, {
        backgroundColor: theme['c-button-background'],
        borderColor: primary ? 'transparent' : theme['c-border-background'],
        opacity: disabled ? 0.3 : pressed ? 0.8 : 1,
      }]}
    >
      <Text size={13} color={theme['c-button-font']} style={[styles.label, kind === 'secondary' ? null : styles.emphasizedLabel]}>{children}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  action: {
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  label: {
    textAlign: 'center',
  },
  emphasizedLabel: {
    fontWeight: '600',
  },
})
