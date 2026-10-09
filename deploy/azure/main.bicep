targetScope = 'resourceGroup'

@description('Azure region for every Nado Control resource.')
param location string = resourceGroup().location

@description('Name of the public Control VM.')
@minLength(1)
@maxLength(64)
param vmName string = 'nado-control'

@description('Linux administrator account. Password authentication is disabled.')
@minLength(1)
param adminUsername string = 'nadoadmin'

@secure()
@description('OpenSSH public key for the administrator account.')
param adminSshPublicKey string

@description('Single operator/network CIDR allowed to reach SSH, for example 203.0.113.10/32.')
param allowedSshSourceCidr string

@description('Public DNS label prefix. The resulting FQDN is emitted after deployment.')
@minLength(3)
@maxLength(63)
param dnsLabelPrefix string = 'nado-${uniqueString(resourceGroup().id)}'

@description('Control VM size. Compute-heavy Agent work belongs on outbound Workers.')
param vmSize string = 'Standard_B2s'

@description('Premium OS disk capacity in GiB.')
@minValue(30)
@maxValue(4095)
param osDiskSizeGiB int = 64

@description('Tags applied to every supported resource.')
param tags object = {
  workload: 'nado-agent'
  role: 'control'
  managedBy: 'bicep'
}

var networkSecurityGroupName = '${vmName}-nsg'
var virtualNetworkName = '${vmName}-vnet'
var subnetName = 'control'
var publicIpName = '${vmName}-pip'
var networkInterfaceName = '${vmName}-nic'
var cloudInit = loadTextContent('cloud-init-control.yaml')

resource networkSecurityGroup 'Microsoft.Network/networkSecurityGroups@2023-09-01' = {
  name: networkSecurityGroupName
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'allow-operator-ssh'
        properties: {
          description: 'SSH is limited to the explicitly supplied operator CIDR.'
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '22'
          sourceAddressPrefix: allowedSshSourceCidr
          destinationAddressPrefix: '*'
        }
      }
      {
        name: 'allow-http-acme'
        properties: {
          description: 'Caddy HTTP redirect and ACME HTTP challenge traffic.'
          priority: 110
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '80'
          sourceAddressPrefix: 'Internet'
          destinationAddressPrefix: '*'
        }
      }
      {
        name: 'allow-https-control'
        properties: {
          description: 'Public Dashboard, CLI, MCP, and outbound Worker HTTPS traffic.'
          priority: 120
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '443'
          sourceAddressPrefix: 'Internet'
          destinationAddressPrefix: '*'
        }
      }
      {
        name: 'deny-public-native-control'
        properties: {
          description: 'Native Control port must stay behind Caddy or a private overlay.'
          priority: 130
          direction: 'Inbound'
          access: 'Deny'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '8765'
          sourceAddressPrefix: 'Internet'
          destinationAddressPrefix: '*'
        }
      }
    ]
  }
}

resource virtualNetwork 'Microsoft.Network/virtualNetworks@2023-09-01' = {
  name: virtualNetworkName
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.77.0.0/16'
      ]
    }
    subnets: [
      {
        name: subnetName
        properties: {
          addressPrefix: '10.77.1.0/24'
          networkSecurityGroup: {
            id: networkSecurityGroup.id
          }
        }
      }
    ]
  }
}

resource publicIp 'Microsoft.Network/publicIPAddresses@2023-09-01' = {
  name: publicIpName
  location: location
  tags: tags
  sku: {
    name: 'Standard'
    tier: 'Regional'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
    idleTimeoutInMinutes: 4
    dnsSettings: {
      domainNameLabel: dnsLabelPrefix
    }
  }
}

resource networkInterface 'Microsoft.Network/networkInterfaces@2023-09-01' = {
  name: networkInterfaceName
  location: location
  tags: tags
  properties: {
    ipConfigurations: [
      {
        name: 'ipconfig1'
        properties: {
          privateIPAllocationMethod: 'Dynamic'
          subnet: {
            id: resourceId('Microsoft.Network/virtualNetworks/subnets', virtualNetwork.name, subnetName)
          }
          publicIPAddress: {
            id: publicIp.id
          }
        }
      }
    ]
  }
}

resource controlVm 'Microsoft.Compute/virtualMachines@2023-09-01' = {
  name: vmName
  location: location
  tags: tags
  identity: {
    type: 'None'
  }
  properties: {
    hardwareProfile: {
      vmSize: vmSize
    }
    securityProfile: {
      securityType: 'TrustedLaunch'
      uefiSettings: {
        secureBootEnabled: true
        vTpmEnabled: true
      }
    }
    osProfile: {
      computerName: vmName
      adminUsername: adminUsername
      customData: base64(cloudInit)
      allowExtensionOperations: false
      linuxConfiguration: {
        disablePasswordAuthentication: true
        provisionVMAgent: true
        patchSettings: {
          assessmentMode: 'AutomaticByPlatform'
          patchMode: 'AutomaticByPlatform'
        }
        ssh: {
          publicKeys: [
            {
              path: '/home/${adminUsername}/.ssh/authorized_keys'
              keyData: adminSshPublicKey
            }
          ]
        }
      }
    }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: '0001-com-ubuntu-server-jammy'
        sku: '22_04-lts-gen2'
        version: 'latest'
      }
      osDisk: {
        name: '${vmName}-os'
        createOption: 'FromImage'
        diskSizeGB: osDiskSizeGiB
        managedDisk: {
          storageAccountType: 'Premium_LRS'
        }
      }
    }
    networkProfile: {
      networkInterfaces: [
        {
          id: networkInterface.id
          properties: {
            primary: true
          }
        }
      ]
    }
    diagnosticsProfile: {
      bootDiagnostics: {
        enabled: true
      }
    }
  }
}

output controlVmName string = controlVm.name
output publicIpAddress string = publicIp.properties.ipAddress
output publicFqdn string = publicIp.properties.dnsSettings.fqdn
output publicHttpsUrl string = 'https://${publicIp.properties.dnsSettings.fqdn}'
output sshCommand string = 'ssh ${adminUsername}@${publicIp.properties.dnsSettings.fqdn}'
output nativeControlInternetExposure string = 'denied by NSG rule deny-public-native-control on TCP 8765'
